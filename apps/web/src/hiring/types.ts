import type { OrganizationPlanSummary } from '../plans/entitlements';
import type { R211AssessmentDraftInput } from '../r211-builder/contract';
import type { R27AiReviewReport } from '../r27-evidence/ai-review-contract';
import type {
  ExperienceLevelId,
  IdDocumentTypeId,
  PipelineStatusId,
  ProblemStructureId,
  WorkModeId,
} from './catalogs';

export type WorkspaceRoleKind = 'cto' | 'recruiter' | 'reviewer';

export interface CandidateProfile {
  readonly principalId: string;
  readonly candidateCode: string;
  readonly email: string;
  readonly fullName: string;
  readonly phone: string;
  readonly birthYear: number | null;
  readonly age: number | null;
  readonly locationCountry: string;
  readonly locationCity: string;
  readonly workMode: WorkModeId;
  readonly headlineRole: string;
  readonly yearsExperience: number;
  readonly experienceLevel: ExperienceLevelId;
  readonly skills: readonly string[];
  readonly idDocumentType: IdDocumentTypeId | null;
  readonly idDocumentMasked: string | null;
  readonly idVerificationStatus: 'unsubmitted' | 'submitted' | 'verified';
  readonly linkedinUrl: string;
  readonly githubUrl: string;
  readonly portfolioUrl: string;
  readonly bio: string;
  readonly profileCompletedAt: string | null;
  readonly updatedAt: string | null;
}

export interface CandidatePublishedOutcome {
  readonly decision: 'accepted' | 'rejected';
  readonly strengths: readonly string[];
  readonly weaknesses: readonly string[];
  readonly feedbackNote: string;
  readonly nextStageLabel: string | null;
  readonly publishedAt: string;
}

export interface CandidatePortalAssessmentItem {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly scenarioTitle: string;
  readonly targetRole: string;
  readonly experienceLevel: string;
  readonly skills: readonly string[];
  readonly durationSeconds: number | null;
  readonly status: 'CREATED' | 'ACTIVE' | 'SUBMITTED';
  readonly pipelineStatus: PipelineStatusId;
  readonly createdAt: string;
  readonly activatedAt: string | null;
  readonly submittedAt: string | null;
  readonly invitationExpiresAt: string | null;
  readonly invitationRevokedAt: string | null;
  readonly invitationActive: boolean;
  readonly publishedOutcome: CandidatePublishedOutcome | null;
}

export interface SavedLibraryProblem {
  readonly definitionId: string;
  readonly validatedVersionId: string;
  readonly organizationId: string;
  readonly authorPrincipalId: string;
  readonly authorName: string;
  readonly title: string;
  readonly brief: string;
  readonly expectedBehavior: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly primaryFilePath: string;
  readonly starterFiles: readonly { path: string; content: string }[];
  readonly durationMinutes: number;
  readonly terminalEnabled: boolean;
  readonly integratedAi: boolean;
  readonly rubric: readonly {
    id: string;
    label: string;
    description: string;
    weight: number;
    applicability: { kind: string; rule: string };
  }[];
  readonly sourceKind: 'template' | 'ai_generated';
  readonly templateId: string | null;
  readonly targetRole: string;
  readonly experienceLevel: ExperienceLevelId;
  readonly yearsExperience: number;
  readonly skills: readonly string[];
  readonly problemStructure: ProblemStructureId;
  readonly workKind: string;
  readonly domain: string;
  readonly issuedCount: number;
  readonly createdAt: string;
}

export type PeerReviewVerdict = 'approve' | 'comment' | 'request_changes';

export interface PeerReviewRequestContext {
  readonly evaluatorStrengths?: readonly string[];
  readonly evaluatorWeaknesses?: readonly string[];
  readonly internalNotesExcerpt?: string;
  readonly aiAdvisory?: {
    readonly headline: string;
    readonly score: number;
    readonly verdictLabel: string;
    readonly rationale: string;
    readonly providerLabel: string;
  } | null;
}

export interface PeerReviewEmailDelivery {
  readonly status: 'sent' | 'not_configured' | 'failed';
  readonly recipientEmail: string;
  readonly inboxUrl?: string;
  readonly reason?: string;
}

export interface SecondOpinionRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly requestedByPrincipalId: string;
  readonly requestedByName: string;
  readonly requestedByEmail?: string;
  readonly requestedReviewerPrincipalId: string;
  readonly requestedReviewerName: string;
  readonly requestedReviewerEmail?: string;
  readonly requestNote: string;
  readonly requestContext?: PeerReviewRequestContext;
  readonly responseNote: string | null;
  readonly verdict?: PeerReviewVerdict | null;
  readonly status: 'pending' | 'completed';
  readonly createdAt: string;
  readonly respondedAt: string | null;
}

export interface PerformanceFitRequirementItem {
  readonly requirement: string;
  readonly status: 'demonstrated' | 'partial' | 'gap' | 'not_assessed';
  readonly evidence: string;
}

export interface PerformanceFitReport {
  readonly overallFitVerdict:
    'strong_fit' | 'good_fit_with_probes' | 'conditional_fit' | 'not_assessed';
  readonly fitHeadline: string;
  readonly whyGoodOrBadFit: string;
  readonly requirementAssessment: readonly PerformanceFitRequirementItem[];
  readonly strengths: readonly string[];
  readonly weaknessesAndRisks: readonly string[];
  readonly clearlyDemonstrated: readonly string[];
  readonly unclearOrNotAssessed: readonly string[];
  readonly suggestedNextInterviewQuestions: readonly string[];
  readonly provider: {
    readonly modelId: string;
    readonly mode: 'live_ai' | 'evidence_summary';
    readonly generatedAt: string;
    readonly fallbackReason?: string;
  };
}

export interface HiringDecisionRecord {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly decidedByPrincipalId: string;
  readonly decidedByName: string;
  readonly decision: 'accepted' | 'rejected';
  readonly candidateStrengths: readonly string[];
  readonly candidateWeaknesses: readonly string[];
  readonly candidateFeedbackNote: string;
  readonly internalNotes: string;
  readonly nextStageLabel: string | null;
  readonly handoffRecipientPrincipalId: string | null;
  readonly handoffRecipientName: string | null;
  readonly handoffStatus: 'none' | 'pending' | 'reviewed' | 'completed';
  readonly performanceReport: PerformanceFitReport | null;
  readonly publishedAt: string;
  readonly updatedAt: string;
}

export interface OrgCandidateSessionItem {
  readonly sessionId: string;
  readonly scenarioTitle: string;
  readonly targetRole: string;
  readonly experienceLevel: string;
  readonly skills: readonly string[];
  readonly durationSeconds: number | null;
  readonly lifecycleStatus: 'CREATED' | 'ACTIVE' | 'SUBMITTED';
  readonly pipelineStatus: PipelineStatusId;
  readonly assignedReviewerPrincipalId: string | null;
  readonly assignedReviewerName: string | null;
  readonly issuerPrincipalId: string;
  readonly issuerName: string;
  readonly createdAt: string;
  readonly activatedAt: string | null;
  readonly submittedAt: string | null;
  readonly invitationActive: boolean;
  readonly invitationExpiresAt: string | null;
  readonly candidateLink?: string | null;
  readonly decision: HiringDecisionRecord | null;
  readonly secondOpinions: readonly SecondOpinionRecord[];
}

export interface OrgCandidateRecord {
  readonly candidateKey: string;
  readonly email: string;
  readonly candidatePrincipalId: string | null;
  readonly candidateCode: string | null;
  readonly fullName: string;
  readonly hasAccount: boolean;
  readonly headlineRole: string;
  readonly yearsExperience: number | null;
  readonly experienceLevel: ExperienceLevelId | null;
  readonly locationCountry: string;
  readonly locationCity: string;
  readonly workMode: WorkModeId | null;
  readonly skills: readonly string[];
  readonly phone: string;
  readonly linkedinUrl: string;
  readonly githubUrl: string;
  readonly portfolioUrl: string;
  readonly bio: string;
  readonly latestPipelineStatus: PipelineStatusId;
  readonly lastActivityAt: string;
  readonly latestSubmittedAt: string | null;
  readonly sessions: readonly OrgCandidateSessionItem[];
}

export interface TeamMemberOption {
  readonly principalId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: WorkspaceRoleKind;
  readonly isOwner: boolean;
}

export interface SessionHiringReviewContext {
  readonly organizationId: string;
  readonly organizationName?: string;
  readonly sessionId: string;
  readonly scenarioTitle?: string;
  readonly currentPrincipalId: string;
  readonly currentRole: WorkspaceRoleKind;
  readonly isOwner: boolean;
  readonly canPublishDecision: boolean;
  readonly plan: OrganizationPlanSummary;
  readonly targetRole: string;
  readonly experienceLevel: string;
  readonly skills: readonly string[];
  readonly candidateEmail: string | null;
  readonly candidateName: string | null;
  readonly candidateCode: string | null;
  readonly decision: HiringDecisionRecord | null;
  readonly secondOpinions: readonly SecondOpinionRecord[];
  readonly teamMembers: readonly TeamMemberOption[];
  readonly initialAiReview?: R27AiReviewReport | null;
}

export interface HandoffDossierItem {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly scenarioTitle: string;
  readonly targetRole: string;
  readonly experienceLevel: string;
  readonly skills: readonly string[];
  readonly candidateEmail: string;
  readonly candidateName: string;
  readonly candidateCode: string | null;
  readonly candidateProfile: {
    readonly headlineRole: string;
    readonly yearsExperience: number | null;
    readonly locationCountry: string;
    readonly locationCity: string;
    readonly workMode: string | null;
    readonly skills: readonly string[];
    readonly linkedinUrl: string;
    readonly githubUrl: string;
    readonly portfolioUrl: string;
    readonly bio: string;
  };
  readonly decision: HiringDecisionRecord;
  readonly secondOpinions: readonly SecondOpinionRecord[];
  readonly submittedAt: string | null;
}

export interface PlatformTemplateView {
  readonly templateId:
    'reservation-moves-v3' | 'webhook-dedup-v1' | 'cache-rate-limiter-v1';
  readonly scenarioId: string;
  readonly scenarioVersion: string;
  readonly title: string;
  readonly summary: string;
  readonly targetRole: string;
  readonly experienceLevel: ExperienceLevelId;
  readonly yearsExperience: number;
  readonly domain: string;
  readonly workKind: string;
  readonly problemStructure: ProblemStructureId;
  readonly skills: readonly string[];
  readonly defaultDurationMinutes: 30 | 45 | 60 | 90;
  readonly baseDraft: R211AssessmentDraftInput;
}

export type SafePortalAssessmentView = CandidatePortalAssessmentItem & {
  readonly canLaunch: boolean;
};
