import { describe, expect, it } from 'vitest';
import { SchedulerInstance, SchedulerLease } from '@monitorly/database';
import { PartitionLeaseManager } from '../src/leases';
import { fakeClock, logger, useTestDatabase } from './helpers';

useTestDatabase();

const TTL = 15_000;

function manager(instanceId: string, clock: () => Date) {
  return new PartitionLeaseManager({ instanceId, ttlMs: TTL, logger, clock });
}

/** Refreshes all managers a few rounds, the way their renew loops would. */
async function settle(managers: PartitionLeaseManager[], advance: (ms: number) => void, rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    for (const m of managers) await m.refresh();
    advance(1_000);
  }
}

describe('PartitionLeaseManager', () => {
  it('a single instance owns every partition', async () => {
    const { clock } = fakeClock();
    const a = manager('a', clock);
    expect(await a.refresh()).toHaveLength(64);
    expect(a.ownedPartitions()).toHaveLength(64);
  });

  it('two instances split the partitions evenly with no overlap', async () => {
    const { clock, advance } = fakeClock();
    const a = manager('a', clock);
    const b = manager('b', clock);
    await a.refresh(); // a starts alone and takes everything
    await settle([b, a], advance);

    const ownedA = a.ownedPartitions();
    const ownedB = b.ownedPartitions();
    expect(ownedA).toHaveLength(32);
    expect(ownedB).toHaveLength(32);
    expect(ownedA.filter((p) => ownedB.includes(p))).toEqual([]);
    expect(new Set([...ownedA, ...ownedB]).size).toBe(64);
  });

  it('three instances cover every partition exactly once', async () => {
    const { clock, advance } = fakeClock();
    const ms = ['a', 'b', 'c'].map((id) => manager(id, clock));
    await settle(ms, advance, 4);

    const all = ms.flatMap((m) => m.ownedPartitions());
    expect(all).toHaveLength(64);
    expect(new Set(all).size).toBe(64);
    for (const m of ms) expect(m.ownedPartitions().length).toBeLessThanOrEqual(22); // ceil(64 / 3)
  });

  it('when an instance crashes, its leases expire and the survivor takes them over', async () => {
    const { clock, advance } = fakeClock();
    const a = manager('a', clock);
    const b = manager('b', clock);
    await settle([a, b], advance);
    expect(a.ownedPartitions()).toHaveLength(32);

    // "b" crashes: it stops renewing. Before the TTL passes, its partitions stay reserved.
    await a.refresh();
    expect(a.ownedPartitions()).toHaveLength(32);

    advance(TTL + 1_000);
    expect(b.ownedPartitions()).toEqual([]); // b's local view: leases lapsed, it must stop scheduling
    await a.refresh();
    expect(a.ownedPartitions()).toHaveLength(64);
  });

  it('a graceful shutdown hands partitions over immediately', async () => {
    const { clock, advance } = fakeClock();
    const a = manager('a', clock);
    const b = manager('b', clock);
    await settle([a, b], advance);

    await b.releaseAll();
    expect(await SchedulerInstance.exists({ _id: 'b' })).toBeNull();
    await a.refresh();
    expect(a.ownedPartitions()).toHaveLength(64);
  });

  it('never claims a partition whose lease another live instance holds', async () => {
    const { clock } = fakeClock();
    const a = manager('a', clock);
    await a.refresh();
    // b appears and refreshes before a has had a chance to hand anything back.
    const b = manager('b', clock);
    expect(await b.refresh()).toEqual([]);
    const owners = await SchedulerLease.distinct('ownerId');
    expect(owners).toEqual(['a']);
  });

  it('two instances starting at the same moment never own the same partition', async () => {
    const { clock, advance } = fakeClock();
    const a = manager('a', clock);
    const b = manager('b', clock);
    await Promise.all([a.refresh(), b.refresh()]);
    const overlap = a.ownedPartitions().filter((p) => b.ownedPartitions().includes(p));
    expect(overlap).toEqual([]);
    await settle([a, b], advance);
    expect(a.ownedPartitions().length + b.ownedPartitions().length).toBe(64);
  });
});
