import type { HistoricalParticipant } from '../shared/types';

export const historicalParticipantName = (participant: HistoricalParticipant) => participant.status === 'deleted' ? `${participant.name} · Deleted account` : participant.status === 'removed' ? `${participant.name} · Removed` : participant.name;
export const minorToInput = (minor: number) => (minor / 100).toFixed(2);
