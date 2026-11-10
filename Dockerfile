FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Runtime files include src, stories, and prompts.
# .dockerignore leaves out sessions, tests, git metadata, and env files.
COPY . .

CMD ["node", "index.js"]
