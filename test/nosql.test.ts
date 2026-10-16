import { describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { agentRefusal, findUnsafe, statementsOf } from '../src/databases.js';
import { parseMongo, redisDb, redisWords } from '../src/nosql.js';

describe('mongosh-style commands', () => {
  it('reads a collection, its calls and mongosh\'s literals, without running anything', () => {
    const c = parseMongo(`db.users.find({ age: { $gt: 30 }, name: /^an/i, 'quoted key': "x", _id: ObjectId("652f0000000000000000000a") }, { name: 1, })
      .sort({ age: -1 }).limit(5);`);
    expect(c.kind).toBe('collection');
    expect(c.collection).toBe('users');
    expect(c.calls.map((x) => x.name)).toEqual(['find', 'sort', 'limit']);
    const filter = c.calls[0]!.args[0] as Record<string, any>;
    expect(filter.age).toEqual({ $gt: 30 });
    expect(filter.name).toMatchObject({ pattern: '^an', options: 'i' });
    expect(filter['quoted key']).toBe('x');
    expect(filter._id).toBeInstanceOf(ObjectId);
    expect(c.calls[0]!.args[1]).toEqual({ name: 1 });
  });

  it('knows getCollection, dotted names, database methods and show', () => {
    expect(parseMongo('db.getCollection("my coll").countDocuments({})')).toMatchObject({ collection: 'my coll', calls: [{ name: 'countDocuments' }] });
    expect(parseMongo('db.system.profile.find()')).toMatchObject({ collection: 'system.profile' });
    expect(parseMongo('db["odd-name"].find()')).toMatchObject({ collection: 'odd-name' });
    expect(parseMongo('db.getCollectionNames()')).toMatchObject({ kind: 'db', calls: [{ name: 'getCollectionNames' }] });
    expect(parseMongo('show dbs')).toMatchObject({ kind: 'show', show: 'dbs' });
    const dates = parseMongo('db.e.find({ at: { $gte: ISODate("2024-01-01"), $lt: new Date("2025-01-01") }, n: NumberLong("9007199254740993") })');
    expect((dates.calls[0]!.args[0] as any).at.$gte).toBeInstanceOf(Date);
    expect(String((dates.calls[0]!.args[0] as any).n)).toBe('9007199254740993');
  });

  it('refuses what it would have to run: variables, functions, use', () => {
    expect(() => parseMongo('db.users.find({ a: someVar })')).toThrow(/not a value here/);
    expect(() => parseMongo('db.users.find({ $where: function () { return true } })')).toThrow();
    expect(() => parseMongo('use shop')).toThrow(/database list/);
    expect(() => parseMongo('db.users')).toThrow(/method call/);
    expect(() => parseMongo('print("hi")')).toThrow(/starts with db/);
  });

  it('splits a script at ; and at lines that start a new command, not inside brackets or strings', () => {
    expect(statementsOf(`db.a.find({
  x: 1;
})
db.b.find({ s: "db.c.find()" }); db.c.count()
// db.d.find()
show dbs`, 'mongodb')).toEqual(['db.a.find({\n  x: 1;\n})', 'db.b.find({ s: "db.c.find()" })', 'db.c.count()', 'show dbs']);
  });

  it('asks before an empty filter or a drop, and refuses server-side JavaScript to agents', () => {
    const u = findUnsafe('db.u.deleteMany({})\ndb.u.deleteMany({ a: 1 })\ndb.u.updateMany({}, { $set: { a: 1 } })\ndb.u.drop()\ndb.dropDatabase()', 'mongodb');
    expect(u.map((x) => `${x.kind}:${x.table}`)).toEqual(['delete:u', 'update:u', 'truncate:u', 'truncate:the database']);
    expect(findUnsafe('show collections\nshow dbs\ndb.getCollectionNames()', 'mongodb')).toEqual([]);
    expect(agentRefusal('db.u.find({ $where: "1" })', 'mongodb', true)).toMatch(/JavaScript/);
    expect(agentRefusal('db.u.aggregate([{ $group: { _id: 1, x: { $accumulator: {} } } }])', 'mongodb', false)).toMatch(/JavaScript/);
    expect(agentRefusal('db.u.find({})', 'mongodb', true)).toBeNull();
  });
});

describe('Redis commands', () => {
  it('splits words the way redis-cli does', () => {
    expect(redisWords('SET "a key" "say \\"hi\\"\\n" \'it\\\'s\' plain')).toEqual(['SET', 'a key', 'say "hi"\n', 'it\'s', 'plain']);
    expect(redisWords('GET "\\x41\\x42"')).toEqual(['GET', 'AB']);
    expect(() => redisWords('GET "open')).toThrow(/not closed/);
  });

  it('takes one command per line, skipping comments', () => {
    expect(statementsOf('GET a\n\n# a comment\n  HGETALL b  \n// another\nSCAN 0', 'redis')).toEqual(['GET a', 'HGETALL b', 'SCAN 0']);
  });

  it('names databases db0..db15', () => {
    expect([redisDb(''), redisDb('3'), redisDb('db12')]).toEqual([0, 3, 12]);
  });

  it('asks before a flush, and refuses the server\'s own commands to agents', () => {
    expect(findUnsafe('GET a\nFLUSHDB\nFLUSHALL', 'redis').map((x) => x.table)).toEqual(['this database', 'every database']);
    for (const cmd of ['CONFIG SET dir /tmp', 'EVAL "return 1" 0', 'KEYS *', 'FLUSHALL', 'DEBUG SLEEP 1', 'MODULE LOAD x']) {
      expect(agentRefusal(cmd, 'redis', false), cmd).toMatch(/refused for agents/);
    }
    expect(agentRefusal('HGETALL user:1', 'redis', true)).toBeNull();
  });
});
