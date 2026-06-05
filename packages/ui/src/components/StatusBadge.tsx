import { Badge } from './ui';
import type { DocStatus } from '../api/types';

interface StatusBadgeProps {
  status: DocStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return <Badge status={status} />;
}
