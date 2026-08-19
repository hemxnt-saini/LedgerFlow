FROM maven:3.9-eclipse-temurin-21 AS build

WORKDIR /app
COPY pom.xml ./
RUN mvn -B -ntp dependency:go-offline

COPY src ./src
RUN mvn -B -ntp -DskipTests package

FROM eclipse-temurin:21-jre-alpine

WORKDIR /app
COPY --from=build /app/target/*.jar app.jar

EXPOSE 4001
CMD ["java", "-XX:MaxRAMPercentage=70.0", "-XX:+UseSerialGC", "-Xss512k", "-jar", "app.jar"]
