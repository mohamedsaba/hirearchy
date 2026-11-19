export const HIRING_ROLES = [
  'Backend Engineer',
  'Frontend Engineer',
  'Full-Stack Engineer',
  'Mobile Engineer',
  'Data Engineer',
  'ML / AI Engineer',
  'Platform / Cloud Engineer',
  'DevOps / SRE',
  'Security Engineer',
  'QA / Test Engineer',
  'Engineering Manager',
] as const;

export const EXPERIENCE_LEVELS = [
  {
    id: 'junior',
    label: 'Junior (0–2 yrs)',
    defaultYears: 1,
    minYears: 0,
    maxYears: 2,
  },
  {
    id: 'mid',
    label: 'Mid-level (2–5 yrs)',
    defaultYears: 3,
    minYears: 2,
    maxYears: 5,
  },
  {
    id: 'senior',
    label: 'Senior (5–8 yrs)',
    defaultYears: 6,
    minYears: 5,
    maxYears: 8,
  },
  {
    id: 'staff',
    label: 'Staff / Lead (8+ yrs)',
    defaultYears: 9,
    minYears: 8,
    maxYears: 50,
  },
] as const;

export type ExperienceLevelId = (typeof EXPERIENCE_LEVELS)[number]['id'];

export const YEARS_EXPERIENCE_OPTIONS = [
  { value: 0, label: '0–1 years (Entry / Junior)' },
  { value: 1, label: '1 year' },
  { value: 2, label: '2 years' },
  { value: 3, label: '3 years' },
  { value: 4, label: '4 years' },
  { value: 5, label: '5 years' },
  { value: 6, label: '6 years' },
  { value: 7, label: '7 years' },
  { value: 8, label: '8+ years' },
  { value: 10, label: '10+ years' },
] as const;

export const CURATED_SKILLS = [
  'Python',
  'TypeScript',
  'JavaScript',
  'React',
  'Next.js',
  'Node.js',
  'PostgreSQL',
  'SQL',
  'REST APIs',
  'GraphQL',
  'Concurrency & Idempotency',
  'Distributed Systems',
  'Caching & Performance',
  'Testing & Debugging',
  'Docker & Containers',
  'System Design',
  'Security',
  'Go',
  'Java',
  'AWS / Cloud',
] as const;

export const CURATED_COUNTRIES = [
  'Egypt',
  'United Arab Emirates',
  'Saudi Arabia',
  'United Kingdom',
  'United States',
  'Germany',
  'Canada',
  'Netherlands',
  'France',
  'Jordan',
  'Lebanon',
  'Morocco',
  'India',
  'Remote / Worldwide',
  'Other',
] as const;

export const WORK_MODES = [
  { id: 'remote', label: 'Remote' },
  { id: 'hybrid', label: 'Hybrid' },
  { id: 'onsite', label: 'On-site' },
  { id: 'any', label: 'Open to any' },
] as const;

export type WorkModeId = (typeof WORK_MODES)[number]['id'];

export const ID_DOCUMENT_TYPES = [
  { id: 'national_id', label: 'National ID' },
  { id: 'passport', label: 'Passport' },
  { id: 'drivers_license', label: "Driver's License" },
] as const;

export type IdDocumentTypeId = (typeof ID_DOCUMENT_TYPES)[number]['id'];

export const NEXT_STAGE_OPTIONS = [
  'Managerial Interview',
  'Technical Deep-Dive (2nd Interview)',
  'System Design Round',
  'Founder / CTO Final Interview',
  'Offer Discussion',
] as const;

export const PIPELINE_STATUS_OPTIONS = [
  { id: 'all', label: 'All stages' },
  { id: 'invited', label: 'Invited (Not started)' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'ready_for_review', label: 'Ready for Review' },
  { id: 'second_opinion', label: 'Second Opinion Requested' },
  { id: 'accepted', label: 'Accepted · Handed Off' },
  { id: 'rejected', label: 'Rejected' },
] as const;

export type PipelineStatusId = (typeof PIPELINE_STATUS_OPTIONS)[number]['id'];

export const CANDIDATE_SORT_OPTIONS = [
  { id: 'recent', label: 'Most recent activity' },
  { id: 'submitted_desc', label: 'Submitted newest' },
  { id: 'experience_desc', label: 'Experience: High to Low' },
  { id: 'experience_asc', label: 'Experience: Low to High' },
  { id: 'status', label: 'Pipeline stage' },
  { id: 'name_asc', label: 'Name (A to Z)' },
] as const;

export type CandidateSortId = (typeof CANDIDATE_SORT_OPTIONS)[number]['id'];

export const WORK_KIND_OPTIONS = [
  { id: 'incident', label: 'Debug & Fix Production Incident' },
  { id: 'feature', label: 'Build a Bounded Feature' },
  { id: 'integration', label: 'Fix API / Webhook Integration' },
  { id: 'data-processing', label: 'Data Pipeline & Reliability' },
] as const;

export const DOMAIN_OPTIONS = [
  { id: 'fintech', label: 'Fintech & Payments' },
  { id: 'travel', label: 'Travel & Bookings' },
  { id: 'commerce', label: 'Commerce & Retail' },
  { id: 'developer-tools', label: 'Developer Tools & SaaS' },
  { id: 'logistics', label: 'Logistics & Supply Chain' },
  { id: 'healthcare', label: 'Healthcare Operations' },
  { id: 'media', label: 'Media & Streaming' },
  { id: 'education', label: 'Education' },
] as const;

export const PROBLEM_STRUCTURE_OPTIONS = [
  {
    id: 'multi_file',
    label: 'Multi-file Repository Investigation',
    description:
      'Candidate navigates realistic interconnected modules, state models, and tests.',
  },
  {
    id: 'single_module',
    label: 'Focused Single-Module Problem',
    description:
      'Compact module and dedicated test suite focused on core algorithmic or API correctness.',
  },
] as const;

export type ProblemStructureId =
  (typeof PROBLEM_STRUCTURE_OPTIONS)[number]['id'];

export const INVITATION_EXPIRY_OPTIONS = [
  { days: 3, label: '3 days' },
  { days: 7, label: '7 days (Recommended)' },
  { days: 14, label: '14 days' },
  { days: 30, label: '30 days' },
] as const;

export const ORGANIZATION_INVITE_ROLES = [
  { id: 'reviewer', label: 'Evaluator / Technical Reviewer' },
  { id: 'recruiter', label: 'Recruiter' },
  { id: 'cto', label: 'CTO / Hiring Manager' },
] as const;

export function experienceLevelLabel(level: string | null | undefined): string {
  return (
    EXPERIENCE_LEVELS.find((item) => item.id === level)?.label ??
    'Mid-level (2–5 yrs)'
  );
}

export function experienceLevelRank(level: string | null | undefined): number {
  switch (level) {
    case 'junior':
      return 1;
    case 'mid':
      return 2;
    case 'senior':
      return 3;
    case 'staff':
      return 4;
    default:
      return 2;
  }
}

export function computeAgeFromBirthYear(
  birthYear: number | null | undefined,
): number | null {
  if (typeof birthYear !== 'number' || !Number.isFinite(birthYear)) return null;
  const age = new Date().getUTCFullYear() - birthYear;
  return age >= 14 && age <= 100 ? age : null;
}
