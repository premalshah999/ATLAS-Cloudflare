// ADR 0017: the providers ATLAS offers must match what the pinned Pi can use. Runs offline (no catalog fetch).
import { afterEach, describe, expect, it } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { PROVIDERS, type PlanRequest } from '@atlas/contracts';
import { PiRuntime } from '../src';
import { tmpDir } from '../../../tests/helpers';

const ALL_ENVS = [...new Set(PROVIDERS.map((p) => p.env))];
const saved = Object.fromEntries(ALL_ENVS.map((e) => [e, process.env[e]]));
const clearEnv = () => { for (const e of ALL_ENVS) delete process.env[e]; };
afterEach(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

const offline = (dir: string) => ModelRuntime.create({ authPath: `${dir}/auth.json`, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });

describe('model providers (ADR 0017)', () => {
  it('every offered provider is a Pi provider with models, and reads the declared variable', async () => {
    clearEnv();
    const rt = await offline(tmpDir('atlas-prov-'));
    const problems: string[] = [];
    for (const p of PROVIDERS) {
      if (!rt.getProvider(p.id)) { problems.push(`${p.id}: not a Pi provider`); continue; }
      if (!rt.getModels(p.id).length) problems.push(`${p.id}: Pi lists no models`);
      if (rt.hasConfiguredAuth(p.id)) problems.push(`${p.id}: configured with no key set`);
    }
    for (const p of PROVIDERS) {
      clearEnv();
      process.env[p.env] = 'sk-atlas-test-0000';
      const withEnv = await offline(tmpDir('atlas-prov-'));
      if (!(await withEnv.getAvailable(p.id)).length) problems.push(`${p.id}: ${p.env} does not configure it`);
    }
    expect(problems).toEqual([]);
  });

  it('a key set at runtime makes exactly that provider\'s models available', async () => {
    clearEnv();
    const pi = new PiRuntime({ agentDir: tmpDir('atlas-prov-'), apiKeys: { mistral: 'sk-atlas-test-0000' } });
    const models = await pi.models();
    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models.map((m) => m.provider))).toEqual(new Set(['mistral']));
    expect(models.every((m) => m.ref.startsWith('mistral/') && m.available)).toBe(true);
  });

  it('refuses a model whose provider has no key, and an unknown model', async () => {
    clearEnv();
    const pi = new PiRuntime({ agentDir: tmpDir('atlas-prov-'), apiKeys: { mistral: 'sk-atlas-test-0000' } });
    const ac = new AbortController();
    const base: PlanRequest = { missionId: 'msn_aaaaaaaa', title: 't', objective: 'o', constraints: '', approvalMode: 'ask_risky', repoMap: '', excerpts: [], roles: [], verification: [], maxTasks: 3, signal: ac.signal };
    const anthropic = PROVIDERS.find((p) => p.id === 'anthropic')!;
    const rt = await offline(tmpDir('atlas-prov-'));
    const someAnthropic = `anthropic/${rt.getModels(anthropic.id)[0].id}`;
    await expect(pi.plan({ ...base, model: someAnthropic })).rejects.toThrow(/No API key for anthropic/);
    await expect(pi.plan({ ...base, model: 'mistral/not-a-model' })).rejects.toThrow(/Model not found/);
  });
});
