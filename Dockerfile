# ---- build stage ----
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src

# Copy pom first for better caching
COPY pom.xml ./
RUN mvn -q -DskipTests dependency:go-offline

# Copy sources
COPY src ./src

# Build jar
RUN mvn -q -DskipTests package

# ---- runtime stage ----
FROM eclipse-temurin:21-jre
WORKDIR /app

# clamdtop (used by the /clamdtop UI tab) comes from clamav-daemon; `script` is
# already provided by the base image (util-linux). --no-install-recommends keeps
# the image lean; the daemon itself is not started in this container.
RUN apt-get update \
    && apt-get install -y --no-install-recommends clamav-daemon \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/data /app/conf

# Copy jar from build stage
COPY --from=build /src/target/clamav-web-client*.jar /app/clamav-web-client.jar

EXPOSE 8080
ENTRYPOINT ["java","-jar","/app/clamav-web-client.jar"]
