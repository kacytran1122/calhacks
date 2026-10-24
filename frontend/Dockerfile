FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY backend ./backend
COPY frontend ./frontend

RUN npm ci --include=dev --prefix backend
RUN npm ci --include=dev --prefix frontend
RUN npm run build --prefix frontend

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/backend ./backend
COPY --from=build /app/frontend ./frontend

EXPOSE 3000

WORKDIR /app/frontend
CMD ["npm", "run", "start"]
