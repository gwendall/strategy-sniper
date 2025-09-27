FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source files
COPY dist ./dist
COPY .env ./

# Run the bot
CMD ["node", "dist/index.js"]