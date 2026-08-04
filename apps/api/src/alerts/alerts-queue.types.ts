export interface AlertDetectionJob {
  tenantId: string;
  patrolId: string;
  kind: 'no_iniciada' | 'atrasada';
}
