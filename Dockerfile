FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Runtime files include src, stories, prompts, and sessions/session-template.json.
# .dockerignore leaves out saved sessions, tests, git metadata, and env files.
COPY . .

CMD ["node", "index.js"]
