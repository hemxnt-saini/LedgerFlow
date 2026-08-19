# Build with Maven, run on a JRE: the runtime image carries no compiler, no
# build cache and no source.
FROM maven:3.9-eclipse-temurin-21 AS build

WORKDIR /app
# Dependencies resolve in their own layer, so a source-only change does not
# re-download the world - the same reason the Node image copied package*.json
# before src.
COPY pom.xml ./
RUN mvn -B -ntp dependency:go-offline

COPY src ./src
RUN mvn -B -ntp -DskipTests package

FROM eclipse-temurin:21-jre-alpine

WORKDIR /app
COPY --from=build /app/target/*.jar app.jar

EXPOSE 4000
# MaxRAMPercentage because the container has a memory limit and the JVM's
# default quarter-of-the-box heap is far below it. SerialGC keeps the footprint
# small for a service this size, which is what the 384M limit in the production
# overlay assumes.
CMD ["java", "-XX:MaxRAMPercentage=70.0", "-XX:+UseSerialGC", "-Xss512k", "-jar", "app.jar"]
