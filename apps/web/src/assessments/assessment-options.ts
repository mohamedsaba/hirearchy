export const assessmentFields = [
  { id: 'frontend', label: 'Frontend engineering', group: 'Web' },
  { id: 'backend', label: 'Backend engineering', group: 'Web' },
  { id: 'full-stack', label: 'Full-stack engineering', group: 'Web' },
  { id: 'ios', label: 'iOS engineering', group: 'Mobile' },
  { id: 'android', label: 'Android engineering', group: 'Mobile' },
  { id: 'flutter', label: 'Flutter engineering', group: 'Mobile' },
  { id: 'react-native', label: 'React Native engineering', group: 'Mobile' },
  { id: 'data-engineering', label: 'Data engineering', group: 'Data & AI' },
  {
    id: 'ml-engineering',
    label: 'Machine learning engineering',
    group: 'Data & AI',
  },
  {
    id: 'ai-applications',
    label: 'AI application engineering',
    group: 'Data & AI',
  },
  {
    id: 'platform',
    label: 'Cloud and platform engineering',
    group: 'Platform',
  },
  { id: 'sre', label: 'Site reliability engineering', group: 'Platform' },
  {
    id: 'security',
    label: 'Application security engineering',
    group: 'Platform',
  },
  {
    id: 'quality-engineering',
    label: 'Quality and test engineering',
    group: 'Quality',
  },
] as const;

export const assessmentWorkKinds = [
  { id: 'incident', label: 'Investigate a production incident' },
  { id: 'feature', label: 'Build a bounded feature' },
  { id: 'integration', label: 'Improve an integration or API' },
  { id: 'data-processing', label: 'Work with a data pipeline' },
] as const;

export const assessmentDomains = [
  { id: 'commerce', label: 'Commerce and retail' },
  { id: 'fintech', label: 'Fintech and payments' },
  { id: 'logistics', label: 'Logistics and supply chain' },
  { id: 'healthcare', label: 'Healthcare operations' },
  { id: 'education', label: 'Education' },
  { id: 'media', label: 'Media and streaming' },
  { id: 'travel', label: 'Travel and bookings' },
  { id: 'public-services', label: 'Public services' },
  { id: 'developer-tools', label: 'Developer tools and SaaS' },
] as const;

export const assessmentStacks = [
  { id: 'python-flask', label: 'Python · Flask' },
  { id: 'typescript-react', label: 'TypeScript · React' },
  { id: 'typescript-node', label: 'TypeScript · Node.js' },
  { id: 'flutter-dart', label: 'Dart · Flutter' },
  { id: 'kotlin-android', label: 'Kotlin · Android' },
  { id: 'swift-ios', label: 'Swift · iOS' },
  { id: 'java-spring', label: 'Java · Spring' },
  { id: 'go-services', label: 'Go · services' },
] as const;

export const assessmentDepths = [
  {
    id: 'contained',
    label: 'Contained',
    description: 'One clear component boundary',
  },
  {
    id: 'layered',
    label: 'Layered',
    description: 'Trace behavior across a few steps',
  },
  {
    id: 'cross-component',
    label: 'Cross-component',
    description: 'Follow effects across services',
  },
] as const;

export const assessmentDurations = [30, 45, 60, 90] as const;

export const supportedAssessmentSelection = {
  field: 'backend',
  workKind: 'incident',
  domain: 'travel',
  stack: 'python-flask',
  depth: 'layered',
  durationMinutes: 60,
} as const;

export type AssessmentSelection = Readonly<{
  field: (typeof assessmentFields)[number]['id'];
  workKind: (typeof assessmentWorkKinds)[number]['id'];
  domain: (typeof assessmentDomains)[number]['id'];
  stack: (typeof assessmentStacks)[number]['id'];
  depth: (typeof assessmentDepths)[number]['id'];
  durationMinutes: (typeof assessmentDurations)[number];
  integratedAi: boolean;
  terminalEnabled?: boolean;
}>;

export const isSupportedAssessmentSelection = (
  selection: AssessmentSelection,
) =>
  selection.stack === 'python-flask' &&
  assessmentFields.some(({ id }) => id === selection.field) &&
  assessmentWorkKinds.some(({ id }) => id === selection.workKind) &&
  assessmentDomains.some(({ id }) => id === selection.domain) &&
  assessmentDepths.some(({ id }) => id === selection.depth) &&
  assessmentDurations.includes(
    selection.durationMinutes as (typeof assessmentDurations)[number],
  );
