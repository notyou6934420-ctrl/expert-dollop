FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install required packages
RUN apt-get update && apt-get install -y \
    curl \
    git \
    ca-certificates \
    build-essential \
    tar \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs

# Create app directory
WORKDIR /app

# Copy the Node.js script into the container
COPY autossh.js /app/autossh.js

# Make script executable
RUN chmod +x /app/autossh.js

# Expose SSH port (2222) that the server will run on
EXPOSE 2222

# Run the auto SSH server setup
CMD ["node", "server.js"]
