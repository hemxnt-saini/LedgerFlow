package com.ledgerflow.query.services;

import com.ledgerflow.query.lib.Log;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.apache.kafka.clients.admin.AdminClient;
import org.apache.kafka.clients.admin.ConsumerGroupDescription;
import org.apache.kafka.clients.admin.ListOffsetsResult.ListOffsetsResultInfo;
import org.apache.kafka.clients.admin.MemberDescription;
import org.apache.kafka.clients.admin.OffsetSpec;
import org.apache.kafka.clients.admin.TopicDescription;
import org.apache.kafka.clients.consumer.OffsetAndMetadata;
import org.apache.kafka.common.TopicPartition;
import org.springframework.stereotype.Service;

/**
 * A read-only window onto the broker, plus the two controls worth having.
 *
 * Everything here comes from Kafka's own admin protocol - partitions, log start
 * and end offsets, consumer group members and their committed offsets. Lag is
 * not a metric this service invents; it is the arithmetic Kafka makes possible:
 * how far the end of the log is ahead of where a group has read to.
 */
@Service
public class KafkaAdminService {

  /**
   * @param low oldest offset still retained.
   * @param high next offset to be written - the end of the log.
   */
  public record PartitionView(
      int partition, long low, long high, long messages, Long committed, long lag) {}

  public record TopicView(
      String topic, List<PartitionView> partitions, long messages, long lag) {}

  public record MemberView(
      String memberId, String clientId, String host, List<String> assignment) {}

  public record GroupView(String groupId, String state, List<MemberView> members) {}

  public record Overview(List<TopicView> topics, List<GroupView> groups) {}

  private final AdminClient admin;

  public KafkaAdminService(AdminClient admin) {
    this.admin = admin;
  }

  public Overview overview(List<String> topics, List<String> groupIds) {
    // Committed offsets are per group per topic, so gather them first and
    // subtract from the log end offset to get lag.
    Map<String, Map<TopicPartition, Long>> committedByGroup = new LinkedHashMap<>();
    for (String groupId : groupIds) {
      try {
        Map<TopicPartition, OffsetAndMetadata> offsets =
            admin.listConsumerGroupOffsets(groupId).partitionsToOffsetAndMetadata().get();
        Map<TopicPartition, Long> perPartition = new HashMap<>();
        offsets.forEach(
            (partition, offset) -> {
              if (offset != null) perPartition.put(partition, offset.offset());
            });
        committedByGroup.put(groupId, perPartition);
      } catch (Exception e) {
        // A group that has never committed is not an error.
        committedByGroup.put(groupId, Map.of());
      }
    }

    List<TopicView> topicViews = new ArrayList<>();
    for (String topic : topics) {
      TopicView view = describeTopic(topic, groupIds, committedByGroup);
      if (view != null) topicViews.add(view);
    }

    return new Overview(topicViews, describeGroups(groupIds));
  }

  private TopicView describeTopic(
      String topic, List<String> groupIds, Map<String, Map<TopicPartition, Long>> committedByGroup) {
    TopicDescription description;
    try {
      description = admin.describeTopics(List.of(topic)).allTopicNames().get().get(topic);
    } catch (Exception e) {
      // A topic that does not exist yet (or was deleted) is not a reason to fail
      // the whole page.
      Log.debug("cannot describe topic", "topic", topic, "err", e);
      return null;
    }
    if (description == null) return null;

    List<TopicPartition> partitions = new ArrayList<>();
    description
        .partitions()
        .forEach(partition -> partitions.add(new TopicPartition(topic, partition.partition())));

    Map<TopicPartition, Long> earliest = listOffsets(partitions, OffsetSpec.earliest());
    Map<TopicPartition, Long> latest = listOffsets(partitions, OffsetSpec.latest());

    // Each topic here is read by exactly one group in this system.
    Map<TopicPartition, Long> groupOffsets = Map.of();
    for (String groupId : groupIds) {
      Map<TopicPartition, Long> offsets = committedByGroup.getOrDefault(groupId, Map.of());
      boolean readsThisTopic = offsets.keySet().stream().anyMatch(tp -> tp.topic().equals(topic));
      if (readsThisTopic) {
        groupOffsets = offsets;
        break;
      }
    }

    List<PartitionView> views = new ArrayList<>(partitions.size());
    for (TopicPartition partition : partitions) {
      long low = earliest.getOrDefault(partition, 0L);
      long high = latest.getOrDefault(partition, 0L);
      Long at = groupOffsets.get(partition);
      // A negative or absent commit means the group has committed nothing on
      // this partition yet. Since the group reads from the beginning, its
      // effective position is the start of the log - so everything retained is
      // still unread, and that is real lag, not "unknown".
      Long committed = at == null || at < 0 ? null : at;
      long position = committed == null ? low : committed;
      views.add(
          new PartitionView(
              partition.partition(), low, high, high - low, committed, Math.max(high - position, 0)));
    }
    views.sort(Comparator.comparingInt(PartitionView::partition));

    long messages = views.stream().mapToLong(PartitionView::messages).sum();
    long lag = views.stream().mapToLong(PartitionView::lag).sum();
    return new TopicView(topic, views, messages, lag);
  }

  private Map<TopicPartition, Long> listOffsets(List<TopicPartition> partitions, OffsetSpec spec) {
    if (partitions.isEmpty()) return Map.of();
    Map<TopicPartition, OffsetSpec> request = new HashMap<>();
    for (TopicPartition partition : partitions) request.put(partition, spec);
    try {
      Map<TopicPartition, ListOffsetsResultInfo> result = admin.listOffsets(request).all().get();
      Map<TopicPartition, Long> offsets = new HashMap<>();
      result.forEach((partition, info) -> offsets.put(partition, info.offset()));
      return offsets;
    } catch (Exception e) {
      Log.debug("cannot list offsets", "err", e);
      return Map.of();
    }
  }

  private List<GroupView> describeGroups(List<String> groupIds) {
    Map<String, ConsumerGroupDescription> described;
    try {
      described = admin.describeConsumerGroups(groupIds).all().get();
    } catch (Exception e) {
      return List.of();
    }

    List<GroupView> groups = new ArrayList<>();
    for (String groupId : groupIds) {
      ConsumerGroupDescription description = described.get(groupId);
      if (description == null) continue;

      List<MemberView> members = new ArrayList<>();
      for (MemberDescription member : description.members()) {
        List<String> assignment = new ArrayList<>();
        member
            .assignment()
            .topicPartitions()
            .forEach(partition -> assignment.add(partition.topic() + "-" + partition.partition()));
        assignment.sort(Comparator.naturalOrder());
        members.add(
            new MemberView(
                member.consumerId().length() > 24
                    ? member.consumerId().substring(0, 24)
                    : member.consumerId(),
                member.clientId(),
                member.host().startsWith("/") ? member.host().substring(1) : member.host(),
                assignment));
      }
      groups.add(new GroupView(groupId, String.valueOf(description.state()), members));
    }
    return groups;
  }
}
