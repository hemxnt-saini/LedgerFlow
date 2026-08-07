import type { Consumer, Kafka } from 'kafkajs';
import { log } from './logger';

/**
 * A read-only window onto the broker, plus the two controls worth having.
 *
 * Everything here comes from Kafka's own admin protocol - partitions, log
 * start and end offsets, consumer group members and their committed offsets.
 * Lag is not a metric this service invents; it is the arithmetic Kafka makes
 * possible: how far the end of the log is ahead of where a group has read to.
 */

export interface PartitionView {
  partition: number;
  /** Oldest offset still retained. */
  low: number;
  /** Next offset to be written - the end of the log. */
  high: number;
  messages: number;
  committed: number | null;
  lag: number;
}

export interface TopicView {
  topic: string;
  partitions: PartitionView[];
  messages: number;
  lag: number;
}

export interface GroupView {
  groupId: string;
  state: string;
  members: { memberId: string; clientId: string; host: string; assignment: string[] }[];
}

export function createKafkaAdmin(kafka: Kafka, topics: string[]) {
  const admin = kafka.admin();
  let connected = false;

  const ensure = async () => {
    if (!connected) {
      await admin.connect();
      connected = true;
    }
    return admin;
  };

  return {
    async overview(groupIds: string[]) {
      const client = await ensure();

      const [metadata, allGroups] = await Promise.all([
        client.fetchTopicMetadata({ topics }),
        client.listGroups(),
      ]);

      // Committed offsets are per group per topic, so gather them first and
      // subtract from the log end offset to get lag.
      const committed = new Map<string, Map<number, number>>();
      for (const groupId of groupIds) {
        for (const topic of topics) {
          try {
            const offsets = await client.fetchOffsets({ groupId, topics: [topic] });
            for (const entry of offsets) {
              const perPartition =
                committed.get(`${groupId}:${entry.topic}`) ?? new Map<number, number>();
              for (const partition of entry.partitions) {
                perPartition.set(partition.partition, Number(partition.offset));
              }
              committed.set(`${groupId}:${entry.topic}`, perPartition);
            }
          } catch {
            // A group that has never committed is not an error.
          }
        }
      }

      const topicViews: TopicView[] = [];
      for (const topic of metadata.topics) {
        const watermarks = await client.fetchTopicOffsets(topic.name);
        // Each topic here is read by exactly one group in this system.
        const groupId = groupIds.find((id) => committed.has(`${id}:${topic.name}`));
        const groupOffsets = groupId ? committed.get(`${groupId}:${topic.name}`) : undefined;

        const partitions: PartitionView[] = watermarks
          .map((mark) => {
            const high = Number(mark.high);
            const low = Number(mark.low);
            const at = groupOffsets?.get(mark.partition);
            // -1, or absent, means the group has committed nothing on this
            // partition yet. Since the group reads from the beginning, its
            // effective position is the start of the log - so everything
            // retained is still unread, and that is real lag, not "unknown".
            const committedAt = at === undefined || at < 0 ? null : at;
            const position = committedAt ?? low;
            return {
              partition: mark.partition,
              low,
              high,
              messages: high - low,
              committed: committedAt,
              lag: Math.max(high - position, 0),
            };
          })
          .sort((a, b) => a.partition - b.partition);

        topicViews.push({
          topic: topic.name,
          partitions,
          messages: partitions.reduce((sum, p) => sum + p.messages, 0),
          lag: partitions.reduce((sum, p) => sum + p.lag, 0),
        });
      }

      const described = await client
        .describeGroups(allGroups.groups.map((g) => g.groupId).filter((id) => groupIds.includes(id)))
        .catch(() => ({ groups: [] as never[] }));

      const groups: GroupView[] = described.groups.map((group) => ({
        groupId: group.groupId,
        state: group.state,
        members: group.members.map((member) => ({
          memberId: member.memberId.slice(0, 24),
          clientId: member.clientId,
          host: member.clientHost,
          assignment: partitionsOf(member.memberAssignment),
        })),
      }));

      return { topics: topicViews, groups };
    },

    async stop() {
      if (connected) await admin.disconnect().catch(() => undefined);
      connected = false;
    },
  };
}

/**
 * Decodes the binary partition assignment kafkajs hands back for a member.
 * Layout: version(2) topicCount(4) [ nameLen(2) name partitionCount(4) [p(4)] ]
 */
function partitionsOf(buffer: Buffer | null): string[] {
  if (!buffer || buffer.length < 6) return [];
  try {
    const out: string[] = [];
    let cursor = 2;
    const topicCount = buffer.readInt32BE(cursor);
    cursor += 4;
    for (let t = 0; t < topicCount; t++) {
      const nameLength = buffer.readInt16BE(cursor);
      cursor += 2;
      const name = buffer.subarray(cursor, cursor + nameLength).toString();
      cursor += nameLength;
      const partitionCount = buffer.readInt32BE(cursor);
      cursor += 4;
      for (let p = 0; p < partitionCount; p++) {
        out.push(`${name}-${buffer.readInt32BE(cursor)}`);
        cursor += 4;
      }
    }
    return out;
  } catch (err) {
    log.debug('could not decode member assignment', { err });
    return [];
  }
}

/**
 * Pausing the consumer is the clearest demonstration this project has: keep
 * paying, watch lag climb partition by partition, resume, watch it drain. The
 * broker held everything in the meantime and nothing was lost - which is the
 * entire reason the queue is there.
 */
export function createConsumerControls(consumer: Consumer, topic: string) {
  let paused = false;
  return {
    isPaused: () => paused,
    pause() {
      if (paused) return;
      consumer.pause([{ topic }]);
      paused = true;
      log.warn('consumer paused - lag will build up', { topic });
    },
    resume() {
      if (!paused) return;
      consumer.resume([{ topic }]);
      paused = false;
      log.info('consumer resumed - draining the backlog', { topic });
    },
    /** Rewind every partition to the start of the log. */
    rewind(partitions: number[]) {
      for (const partition of partitions) {
        consumer.seek({ topic, partition, offset: '0' });
      }
      log.warn('rewound to the beginning of the log', { topic, partitions });
    },
  };
}
