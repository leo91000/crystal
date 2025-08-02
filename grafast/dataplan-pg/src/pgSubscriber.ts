import EventEmitter from "eventemitter3";
import type { Deferred, GrafastSubscriber } from "grafast";
import { defer } from "grafast";
import type { PgPool } from "@graphile/pg-adapters";

export class PgSubscriber<
  TTopics extends { [key: string]: string } = { [key: string]: string },
> implements GrafastSubscriber<TTopics>
{
  private topics: { [topic in keyof TTopics]?: AsyncIterableIterator<any>[] } = {};
  private eventEmitter = new EventEmitter();
  private alive = true;
  private unlisteners: Map<string, () => Promise<void>> = new Map();

  constructor(private pgPool: PgPool) {
    if (!pgPool.listen) {
      throw new Error("PgPool does not support LISTEN/NOTIFY");
    }
  }

  subscribe<TTopic extends keyof TTopics>(
    topic: TTopic,
  ): AsyncIterableIterator<TTopics[TTopic]> {
    if (!this.alive) {
      throw new Error("This PgSubscriber has been released.");
    }

    const topicString = topic as string;
    const stack: any[] = [];
    const queue: Deferred<any>[] = [];
    let finished: IteratorReturnResult<any> | false = false;

    const doFinally = (value?: any) => {
      if (!finished) {
        finished = { done: true, value };
        if (queue) {
          const promises = queue.splice(0, queue.length);
          promises.forEach((p) => p.resolve(finished));
        }
        this.eventEmitter.removeListener(topicString, recv);
        const idx = this.topics[topic]?.indexOf(asyncIterableIterator);
        if (idx != null && idx >= 0) {
          this.topics[topic]!.splice(idx, 1);
          if (this.topics[topic]!.length === 0) {
            delete this.topics[topic];
            this.unlisten(topicString);
          }
        }
      }
      return finished;
    };

    const asyncIterableIterator: AsyncIterableIterator<any> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        if (stack.length > 0) {
          const value = await stack.shift();
          return { done: false, value };
        } else if (finished) {
          return finished;
        } else {
          const waiting = defer();
          queue.push(waiting);
          const value = await waiting;
          return { done: false, value };
        }
      },
      async return(value) {
        return doFinally(value);
      },
      async throw() {
        return doFinally();
      },
    };

    const recv = (payload: any) => {
      if (queue.length > 0) {
        const first = queue.shift();
        first!.resolve(payload);
      } else {
        stack.push(payload);
      }
    };

    this.eventEmitter.addListener(topicString, recv);

    if (!this.topics[topic]) {
      this.topics[topic] = [asyncIterableIterator];
      this.listen(topicString);
    } else {
      this.topics[topic]!.push(asyncIterableIterator);
    }

    return asyncIterableIterator;
  }

  private async listen(topic: string) {
    if (!this.pgPool.listen) return;

    try {
      const { unlisten } = await this.pgPool.listen(
        topic,
        (payload) => {
          this.eventEmitter.emit(topic, payload);
        },
        (error) => {
          console.error(`Error listening to channel "${topic}":`, error);
        }
      );
      this.unlisteners.set(topic, unlisten);
    } catch (error) {
      console.error(`Failed to listen to channel "${topic}":`, error);
    }
  }

  private async unlisten(topic: string) {
    const unlisten = this.unlisteners.get(topic);
    if (unlisten) {
      try {
        await unlisten();
        this.unlisteners.delete(topic);
      } catch (error) {
        console.error(`Error unlistening from channel "${topic}":`, error);
      }
    }
  }

  public async release(): Promise<void> {
    if (this.alive) {
      this.alive = false;
      
      for (const topic of Object.keys(this.topics)) {
        for (const asyncIterableIterator of this.topics[topic as keyof TTopics]!) {
          if (asyncIterableIterator.return) {
            asyncIterableIterator.return();
          } else if (asyncIterableIterator.throw) {
            asyncIterableIterator.throw(new Error("Released"));
          } else {
            console.error(
              `Could not return or throw from iterator for topic '${topic}'`,
            );
          }
        }
        delete this.topics[topic as keyof TTopics];
      }

      for (const [topic, unlisten] of this.unlisteners) {
        try {
          await unlisten();
        } catch (error) {
          console.error(`Error unlistening during release from "${topic}":`, error);
        }
      }
      this.unlisteners.clear();
    }
  }
}