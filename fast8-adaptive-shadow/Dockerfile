FROM node:22-alpine
WORKDIR /app
COPY core.mjs app.mjs trainer.mjs ./
ENV NODE_ENV=production
ENV PORT=3000
ENV SHADOW_DATA_DIR=/data
EXPOSE 3000
CMD ["node","app.mjs"]
