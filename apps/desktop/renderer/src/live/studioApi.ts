// Agent Studio's create flows: custom agents (skills bound to one role), skills and MCP connectors, through the
// control plane's skills.* and mcp.* methods. The design screens reach these through the DesignAdapter.
import type { AgentRole, McpServerConfig, McpServerView } from '@atlas/contracts';
import type { StudioConnector, StudioConnectorDraft, StudioSkill, StudioSkillDraft } from '../lib/store';
import { call, type SkillsState } from './api';

export const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const CONNECTOR_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
export const AGENT_PREFIX = 'agent-';
const ROLES: readonly AgentRole[] = ['orchestrator', 'coder', 'reviewer', 'tester', 'browser_qa', 'desktop_operator', 'deployment_verifier', 'security_reviewer'];
const asRoles = (rs: string[]): AgentRole[] => rs.filter((r): r is AgentRole => (ROLES as readonly string[]).includes(r));

function skills(s: SkillsState): StudioSkill[] {
  return s.trusted.map((k) => ({ name: k.name, description: k.description, roles: k.roles, triggers: k.triggers, enabled: k.enabled, source: k.source === 'operator' ? 'operator' : 'bundled', version: k.version }));
}

function connectors(list: McpServerView[]): StudioConnector[] {
  return list.map(({ config: c, tools, secretsSet, status, error }) => ({
    name: c.name, transport: c.transport, target: c.transport === 'http' ? c.url ?? '' : [c.command ?? '', ...c.args].join(' '),
    enabled: c.enabled, roles: c.roles, secrets: c.secrets, secretsSet, status, error, tools: tools.map((t) => t.name), approval: c.approval,
  }));
}

export const listSkills = async () => skills(await call('skills.list', {}));

export async function saveSkill(d: StudioSkillDraft) {
  if (!KEBAB.test(d.name)) throw new Error('Name: lowercase words joined by hyphens, for example release-notes.');
  if (!d.description.trim()) throw new Error('Add a description: agents read it to decide when to load the skill.');
  if (!d.body.trim()) throw new Error('Write the instructions.');
  return skills(await call('skills.save', { name: d.name, description: d.description.trim(), roles: asRoles(d.roles), triggers: d.triggers.map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 40), body: d.body }));
}

export const setSkillEnabled = async (name: string, enabled: boolean) => skills(await call('skills.setEnabled', { name, enabled }));
export const removeSkill = async (name: string) => skills(await call('skills.remove', { name }));

export const listConnectors = async () => connectors(await call('mcp.list'));

export async function saveConnector(d: StudioConnectorDraft) {
  if (!CONNECTOR_NAME.test(d.name)) throw new Error('Name: lowercase letters, digits and hyphens (up to 40).');
  const secret = d.secretName?.trim();
  if (secret && !SECRET_NAME.test(secret)) throw new Error('Secret name: letters, digits, _ and -, starting with a letter or _.');
  const base = { name: d.name, transport: d.transport, enabled: true, approval: d.approval ?? 'ask', roles: asRoles(d.roles), tools: null, secrets: secret ? [secret] : [] } as const;
  let server: McpServerConfig;
  if (d.transport === 'http') {
    const url = (d.url ?? '').trim();
    let u: URL;
    try { u = new URL(url); } catch { throw new Error('URL: a full address such as https://mcp.example.com/mcp.'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('URL: use https (plain http only for localhost).');
    if (u.username || u.password) throw new Error('Put credentials in the secret header, not in the URL.');
    server = { ...base, roles: [...base.roles], secrets: [...base.secrets], url, args: [], env: {}, network: false, readPaths: [] };
  } else {
    const command = (d.command ?? '').trim();
    if (!command) throw new Error('Command: the program that starts the server, for example npx.');
    server = { ...base, roles: [...base.roles], secrets: [...base.secrets], command, args: d.args.map((a) => a.trim()).filter(Boolean), env: {}, network: !!d.network, readPaths: [] };
  }
  let list = await call('mcp.save', { server });
  if (secret && d.secretValue?.trim()) list = await call('mcp.secret.set', { server: d.name, name: secret, value: d.secretValue.trim() });
  return connectors(list);
}

export const testConnector = async (name: string) => connectors(await call('mcp.test', { name }));
export const removeConnector = async (name: string) => connectors(await call('mcp.remove', { name }));
export const setConnectorSecret = async (server: string, name: string, value: string) => connectors(await call('mcp.secret.set', { server, name, value }));
