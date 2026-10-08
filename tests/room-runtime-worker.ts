// Private inspection exists only in this test entry; production exports no inspection endpoint.
import app, { PingRoom as ProductionRoom } from '../src/index.ts';
import type { Env } from '../src/env.ts';
export class PingRoom extends ProductionRoom {
  inspectFixture() {
    return {
      state: JSON.parse(this.ctx.storage.sql.exec<{value:string}>('SELECT value FROM room WHERE id=1').toArray()[0].value),
      subscriptions: this.ctx.storage.sql.exec<{count:number}>('SELECT COUNT(*) AS count FROM subscriptions').toArray()[0].count,
    };
  }
}
export default {
  async fetch(request: Request, env: Env & { ROOMS: DurableObjectNamespace<PingRoom> }) {
    const url=new URL(request.url);
    if(url.pathname==='/inspect') {
      const stub=env.ROOMS.get(env.ROOMS.idFromName(url.searchParams.get('room')!));
      return Response.json(await stub.inspectFixture());
    }
    return app.fetch(request, env);
  },
};
