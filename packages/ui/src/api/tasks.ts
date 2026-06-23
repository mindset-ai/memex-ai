// spec-354 sol-2: carved out of the former all-domains api/client.ts (which
// is now a barrel re-exporting this module). Behaviour-preserving move only.

import type { Task, PlanReadinessEntry } from './types';
import { fetchWithRetry } from './http';
import { tBase } from './internal';

export async function fetchTasks(docId: string): Promise<Task[]> {
  const res = await fetchWithRetry(`${tBase()}/tasks/doc/${docId}`);
  if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`);
  return res.json();
}

// Batched plan readiness (one POST replaces N per-task fetches). Empty input
// short-circuits without a request — typical specs have a handful of tasks
// with linked plans, so this stays cheap. Cross-tenant ids are silently dropped
// server-side; here we just return whatever the server gives us.
export async function fetchPlanReadiness(taskIds: string[]): Promise<PlanReadinessEntry[]> {
  if (taskIds.length === 0) return [];
  const res = await fetchWithRetry(`${tBase()}/execution-plans/readiness`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds }),
  });
  if (!res.ok) throw new Error(`Failed to fetch plan readiness: ${res.status}`);
  return res.json();
}

export async function createTaskApi(
  docId: string,
  title: string,
  description: string
): Promise<Task> {
  const res = await fetchWithRetry(`${tBase()}/tasks/doc/${docId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, description }),
  });
  if (!res.ok) throw new Error(`Failed to create task: ${res.status}`);
  return res.json();
}

export async function updateTaskStatusApi(
  id: string,
  status: string
): Promise<Task> {
  const res = await fetchWithRetry(`${tBase()}/tasks/${id}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`Failed to update task: ${res.status}`);
  return res.json();
}

export async function addBlockerApi(
  taskId: string,
  blockedBy: string
): Promise<Task> {
  const res = await fetchWithRetry(`${tBase()}/tasks/${taskId}/blockers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blockedBy }),
  });
  if (!res.ok) throw new Error(`Failed to add blocker: ${res.status}`);
  return res.json();
}

export async function removeBlockerApi(
  taskId: string,
  handle: string
): Promise<Task> {
  const res = await fetchWithRetry(`${tBase()}/tasks/${taskId}/blockers/${handle}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Failed to remove blocker: ${res.status}`);
  return res.json();
}
