FROM ubuntu:24.04

WORKDIR /app


RUN apt update && apt install -y curl wget ca-certificates gnupg

# Install Node.js 22 directly from NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs

# Copy application
COPY . .
# Install dependencies
COPY package.json ./
RUN corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN pnpm install


# Create data directory for SQLite
RUN mkdir -p /app/data

# Expose port
EXPOSE 3003 $PORT

# Run the application
# CMD ["node", "index.js"]
ENTRYPOINT ["pnpm", "start"]

