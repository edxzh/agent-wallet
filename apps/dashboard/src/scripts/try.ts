/**
 * "Try to make it overspend" (specs/003-try-to-overspend): runs a preset or custom attack as a
 * dry run of the wallet contract and shows its answer for each payment. The page decides nothing
 * itself (FR-001); every verdict comes from the contract's event.
 */
import { formatUnits, isAddress, parseUnits } from 'viem';
import type { Payment } from '../lib/attacks';
import { dryRun, type Answer } from '../lib/simulate';

type TryData = {
  wallet: string;
  attacks: { id: string; payments: Payment[] }[];
  payees: Record<string, string>;
  services: Record<string, string>;
  tasks: Record<string, string>;
  text: Record<string, string>;
  reasons: Record<string, string>;
};

const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usdc = (base: bigint) => formatUnits(base, 6);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

export function start(): void {
  const raw = document.getElementById('aw-try')?.textContent;
  const out = document.getElementById('aw-try-result');
  const form = document.getElementById('aw-try-form') as HTMLFormElement | null;
  if (!raw || !out || !form) return;
  const result: HTMLElement = out;
  const data = JSON.parse(raw) as TryData;
  const tx = data.text;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button[data-attack], #aw-try-form button[type=submit]')];
  let busy = false;

  const describe = (p: Payment, i: number) => {
    const payee = data.payees[p.payee.toLowerCase()] ?? short(p.payee);
    const parts = [fill(tx.payment!, { n: i + 1, amount: usdc(BigInt(p.amount)), payee })];
    if (p.taskId) parts.push(fill(tx.task!, { task: data.tasks[p.taskId] ?? short(p.taskId) }));
    if (p.claim) parts.push(fill(tx.claims!, { service: data.services[p.claim] ?? `#${p.claim}` }));
    return parts.join(' · ');
  };

  const verdict = (a: Answer) => {
    if ('error' in a) return { text: fill(tx.error!, { error: a.error }), ok: 'false' };
    if (a.reason === 'NONE') return { text: tx.allowed!, ok: 'true' };
    return { text: fill(tx.refused!, { reason: data.reasons[a.reason] ?? a.reason }), ok: 'false' };
  };

  async function run(payments: Payment[]) {
    if (busy) return;
    busy = true;
    buttons.forEach((b) => (b.disabled = true));
    result.replaceChildren(el('p', tx.running, 'muted'));
    result.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    try {
      const res = await dryRun(data.wallet, payments);
      const list = el('ol');
      list.setAttribute('role', 'list');
      let tried = 0n;
      let allowed = 0n;
      res.answers.forEach((a, i) => {
        const p = payments[i]!;
        tried += BigInt(p.amount);
        if ('reason' in a && a.reason === 'NONE') allowed += BigInt(p.amount);
        const v = verdict(a);
        const li = el('li');
        const badge = el('span', v.text, 'verdict');
        badge.dataset.ok = v.ok;
        li.append(el('span', describe(p, i), 'what'), badge);
        list.append(li);
      });
      result.replaceChildren(
        el('p', fill(tx.summary!, { tried: usdc(tried), allowed: usdc(allowed) }), 'summary'),
        list,
        el('p', fill(tx.dryRun!, { block: res.block }), 'muted'),
      );
    } catch {
      result.replaceChildren(el('p', tx.network, 'muted'));
    } finally {
      busy = false;
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  for (const b of document.querySelectorAll<HTMLButtonElement>('button[data-attack]')) {
    const attack = data.attacks.find((a) => a.id === b.dataset.attack);
    if (attack) b.addEventListener('click', () => run(attack.payments));
  }

  const field = <T extends HTMLElement>(name: string) => form.elements.namedItem(name) as T;
  const payee = field<HTMLSelectElement>('payee');
  const other = form.querySelector<HTMLLabelElement>('label.other')!;
  const invalid = form.querySelector<HTMLParagraphElement>('.invalid')!;
  // Also on start: the visitor may have changed it before this script loaded.
  const syncOther = () => (other.hidden = payee.value !== 'other');
  payee.addEventListener('change', syncOther);
  syncOther();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const address = payee.value === 'other' ? field<HTMLInputElement>('address').value.trim() : payee.value;
    const amountText = field<HTMLInputElement>('amount').value.trim();
    let amount: bigint | undefined;
    if (/^\d{1,18}(\.\d{1,6})?$/.test(amountText)) amount = parseUnits(amountText, 6);
    const problem = !isAddress(address, { strict: false }) ? tx.address : amount === undefined ? tx.amount : '';
    invalid.textContent = problem ?? '';
    invalid.hidden = !problem;
    if (problem || amount === undefined) return;
    const one: Payment = {
      payee: address,
      amount: String(amount),
      taskId: field<HTMLSelectElement>('task').value || null,
      claim: field<HTMLSelectElement>('claim').value || null,
    };
    const times = Math.min(5, Math.max(1, Number(field<HTMLSelectElement>('repeat').value) || 1));
    run(Array.from({ length: times }, () => ({ ...one })));
  });

  buttons.forEach((b) => (b.disabled = false));
}
