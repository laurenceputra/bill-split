import type { Expense, Group, GroupMember, Settlement, Balances } from '../shared/types';
const devEmail = () => localStorage.getItem('dev-email') || 'dev@example.com';
export async function api<T>(path: string, init?: RequestInit): Promise<T> { const headers = new Headers(init?.headers); headers.set('Content-Type', 'application/json'); if (import.meta.env.DEV) headers.set('X-Dev-Email', devEmail()); const response = await fetch(`/api${path}`, { ...init, headers }); if (!response.ok) { const body = await response.json().catch(() => null); const error = new Error(body?.error?.message || `Request failed (${response.status})`) as Error & { code?: string }; error.code = body?.error?.code; throw error; } return response.status === 204 ? undefined as T : response.json(); }
export const getGroups=()=>api<{groups:Group[]}>('/groups');
export const getGroup=(id:string)=>api<{group:Group;members:GroupMember[]}>(`/groups/${id}`);
export const getExpenses=(id:string)=>api<{expenses:Expense[]}>(`/groups/${id}/expenses`);
export const getBalances=(id:string)=>api<{balances:Record<string,Balances>}>(`/groups/${id}/balances`);
export const getSettlements=(id:string)=>api<{settlements:Settlement[]}>(`/groups/${id}/settlements`);
export const getExpense=(id:string)=>api<{expense:Expense}>(`/expenses/${id}`).then((result)=>result.expense);
