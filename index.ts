import { Hono } from "hono";
import { todos } from "./data.json";
import { Ratelimit } from "@upstash/ratelimit";
import { Context } from "hono";
import { BlankInput, Env } from "hono/types";
import { env } from "hono/adapter";
import { Redis } from "@upstash/redis/cloudflare";

declare module "hono" {
  interface ContextVariableMap {
    ratelimit: Ratelimit;
  }
}
const app = new Hono();

const cache = new Map();

class RedisRateLimiter {
  static instance: Ratelimit;

  static getInstance(c: Context<Env, "todos/:id", BlankInput>) {
    //this is a singleton pattern , we only make an instance if there is no prior instance alreay made , this is just an optimiztion technique
    if (!this.instance) {
      const { REDIS_URL, REDIS_TOKEN } = env<{
        REDIS_URL: string;
        REDIS_TOKEN: string;
      }>(c);
      // for making a redis instance we use the upstash redis databse wrapper
      // defualt it expects a nodejs runtime but we are deploying to cloudflare workers so we have to change it
      const redisClient = new Redis({
        token: REDIS_TOKEN,
        url: REDIS_URL,
      });

      // class given by upstash so we do not have to wirte everything manually
      // Using sliding window here
      // Other options were :1 ) Token bucket 2:) Leaking bucket 3:) Fixed window counter
      // here 10, "10 s" implies that 10 request are allowed every 10 seconds
      // ephemeralCache this is to keep a global cache of idnetifiers ( hashmap )
      // i.e how many time have an ip made the request
      const ratelimit = new Ratelimit({
        redis: redisClient,
        limiter: Ratelimit.slidingWindow(10, "10 s"),
        ephemeralCache: cache,
      });

      this.instance = ratelimit;
      return this.instance;
    } else {
      return this.instance;
    }
  }
}
// this is a middleware to attach the ratelimit to the gobal context c so that we can use that in the api route
app.use(async (c, next) => {
  const ratelimit = RedisRateLimiter.getInstance(c);
  c.set("ratelimit", ratelimit);
  await next();
});
// c is the context from hono
app.get("/todos/:id", async (c) => {
  const ratelimit = c.get("ratelimit");
  const ip = c.req.raw.headers.get("CF-Connecting-IP");

  const { success } = await ratelimit.limit(ip ?? "anonymous");

  if (success) {
    const todoId = c.req.param("id");
    const todoIndex = Number(todoId);
    const todo = todos[todoIndex] || {};
    return c.json(todo);
  } else {
    return c.json({ message: "Too many requests" }, { status: 429 });
  }
});

export default app;
