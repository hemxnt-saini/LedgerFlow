package com.ledgerflow.payment.config;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.JsonSerializer;
import com.fasterxml.jackson.databind.SerializerProvider;
import com.fasterxml.jackson.databind.module.SimpleModule;
import com.ledgerflow.payment.lib.Iso;
import java.io.IOException;
import java.time.Instant;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Timestamps go out exactly as `Date.toISOString()` wrote them: UTC,
 * milliseconds, trailing `Z`.
 *
 * Jackson's own ISO output drops a zero fraction, so an event that happened on
 * a whole second would serialise differently from one that did not. The wallet
 * and the read model both slice and parse these strings, so one shape for all
 * of them is worth five lines.
 */
@Configuration
public class JacksonConfig {

  @Bean
  public SimpleModule isoInstantModule() {
    SimpleModule module = new SimpleModule();
    module.addSerializer(
        Instant.class,
        new JsonSerializer<Instant>() {
          @Override
          public void serialize(Instant value, JsonGenerator gen, SerializerProvider serializers)
              throws IOException {
            gen.writeString(Iso.format(value));
          }
        });
    return module;
  }
}
