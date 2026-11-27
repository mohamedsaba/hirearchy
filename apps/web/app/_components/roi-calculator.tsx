'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { getPlanDefinition, type PlanTier } from '../../src/plans/entitlements';
import { Arrow } from '../home/site';

export interface RoiInputs {
  targetHires: number;
  candidatesPerHire: number;
  hoursSavedPerCandidate: number;
  hourlyCostUsd: number;
}

export type RecommendedPaidTier = Exclude<PlanTier, 'none'>;

export interface RoiResult {
  totalAssessments: number;
  hoursReclaimed: number;
  engineeringWeeksEquivalent: number;
  reclaimedValueUsd: number;
  onsiteHoursAvoided: number;
  recommendedTier: RecommendedPaidTier;
  tierName: string;
  tierRationale: string;
}

export const DEFAULT_ROI_INPUTS: RoiInputs = {
  targetHires: 8,
  candidatesPerHire: 6,
  hoursSavedPerCandidate: 2.5,
  hourlyCostUsd: 110,
};

export function clampRoiInputs(inputs: Partial<RoiInputs>): RoiInputs {
  const targetHires = Math.max(
    1,
    Math.min(
      100,
      Math.round(Number(inputs.targetHires) || DEFAULT_ROI_INPUTS.targetHires),
    ),
  );
  const candidatesPerHire = Math.max(
    2,
    Math.min(
      25,
      Math.round(
        Number(inputs.candidatesPerHire) ||
          DEFAULT_ROI_INPUTS.candidatesPerHire,
      ),
    ),
  );
  const rawSaved = Number(inputs.hoursSavedPerCandidate);
  const hoursSavedPerCandidate = Math.max(
    1,
    Math.min(
      4,
      Number.isFinite(rawSaved)
        ? Math.round(rawSaved * 2) / 2
        : DEFAULT_ROI_INPUTS.hoursSavedPerCandidate,
    ),
  );
  const rawCost = Number(inputs.hourlyCostUsd);
  const hourlyCostUsd = Math.max(
    60,
    Math.min(
      220,
      Number.isFinite(rawCost)
        ? Math.round(rawCost / 5) * 5
        : DEFAULT_ROI_INPUTS.hourlyCostUsd,
    ),
  );
  return {
    targetHires,
    candidatesPerHire,
    hoursSavedPerCandidate,
    hourlyCostUsd,
  };
}

export function recommendPlanTierForVolume(
  totalAssessments: number,
): RecommendedPaidTier {
  if (totalAssessments <= 15) return 'per_candidate';
  if (totalAssessments <= 60) return 'pro';
  return 'ultra';
}

export function calculateEngineeringRoi(inputs: RoiInputs): RoiResult {
  const safe = clampRoiInputs(inputs);
  const totalAssessments = safe.targetHires * safe.candidatesPerHire;
  const hoursReclaimed =
    Math.round(totalAssessments * safe.hoursSavedPerCandidate * 10) / 10;
  const engineeringWeeksEquivalent = Number((hoursReclaimed / 40).toFixed(1));
  const reclaimedValueUsd = Math.round(hoursReclaimed * safe.hourlyCostUsd);
  const onsiteHoursAvoided = Math.round(totalAssessments * 0.4 * 3);
  const recommendedTier = recommendPlanTierForVolume(totalAssessments);
  const plan = getPlanDefinition(recommendedTier);

  const tierRationale =
    recommendedTier === 'per_candidate'
      ? 'Pay only per distinct candidate email (re-issuing to the same candidate reuses their slot).'
      : recommendedTier === 'pro'
        ? 'Unlimited invitations, AI Assessment Builder, Saved Problem Library, and peer second opinions.'
        : 'Adds advisory AI Candidate Reviews with chronological Δ timing deltas and Managerial Fit Reports on acceptance.';

  return {
    totalAssessments,
    hoursReclaimed,
    engineeringWeeksEquivalent,
    reclaimedValueUsd,
    onsiteHoursAvoided,
    recommendedTier,
    tierName: plan.name,
    tierRationale,
  };
}

export function RoiCalculator({
  initialHires = DEFAULT_ROI_INPUTS.targetHires,
  ctaHrefBase = '/early-access',
  ctaLabel = 'Request early access with this estimate',
}: {
  initialHires?: number;
  ctaHrefBase?: string;
  ctaLabel?: string;
}) {
  const baseId = useId();
  const [inputs, setInputs] = useState<RoiInputs>(() =>
    clampRoiInputs({ ...DEFAULT_ROI_INPUTS, targetHires: initialHires }),
  );

  const result = calculateEngineeringRoi(inputs);
  const usdFormatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

  const ctaHref = `${ctaHrefBase}?tier=${result.recommendedTier}&assessments=${result.totalAssessments}`;

  return (
    <div className="ct-roi-card" data-testid="roi-calculator">
      <div className="ct-roi-header">
        <div>
          <p className="ct-kicker">Engineering time &amp; ROI estimator</p>
          <h3>Protect senior engineering hours before the onsite loop.</h3>
        </div>
        <div
          className="ct-roi-tier-badge"
          data-testid="roi-tier-badge"
          data-tier={result.recommendedTier}
        >
          <span className="ct-roi-tier-eyebrow">Recommended tier</span>
          <strong>{result.tierName}</strong>
        </div>
      </div>

      <div className="ct-roi-grid">
        <div className="ct-roi-inputs">
          <div className="ct-roi-field">
            <div className="ct-roi-field-row">
              <label htmlFor={`${baseId}-hires`}>
                Target engineering hires / year
              </label>
              <output htmlFor={`${baseId}-hires`}>{inputs.targetHires}</output>
            </div>
            <input
              id={`${baseId}-hires`}
              type="range"
              min={1}
              max={100}
              step={1}
              value={inputs.targetHires}
              onChange={(e) =>
                setInputs((prev) => ({
                  ...prev,
                  targetHires: Number(e.target.value),
                }))
              }
            />
            <div className="ct-roi-bounds">
              <span>1 hire</span>
              <span>100 hires</span>
            </div>
          </div>

          <div className="ct-roi-field">
            <div className="ct-roi-field-row">
              <label htmlFor={`${baseId}-candidates`}>
                Candidates assessed per hire
              </label>
              <output htmlFor={`${baseId}-candidates`}>
                {inputs.candidatesPerHire}
              </output>
            </div>
            <input
              id={`${baseId}-candidates`}
              type="range"
              min={2}
              max={25}
              step={1}
              value={inputs.candidatesPerHire}
              onChange={(e) =>
                setInputs((prev) => ({
                  ...prev,
                  candidatesPerHire: Number(e.target.value),
                }))
              }
            />
            <div className="ct-roi-bounds">
              <span>2 / hire</span>
              <span>25 / hire</span>
            </div>
          </div>

          <div className="ct-roi-field">
            <div className="ct-roi-field-row">
              <label htmlFor={`${baseId}-hours`}>
                Screening &amp; debrief hours saved / candidate
              </label>
              <output htmlFor={`${baseId}-hours`}>
                {inputs.hoursSavedPerCandidate.toFixed(1)} hrs
              </output>
            </div>
            <input
              id={`${baseId}-hours`}
              type="range"
              min={1}
              max={4}
              step={0.5}
              value={inputs.hoursSavedPerCandidate}
              onChange={(e) =>
                setInputs((prev) => ({
                  ...prev,
                  hoursSavedPerCandidate: Number(e.target.value),
                }))
              }
            />
            <div className="ct-roi-bounds">
              <span>1.0 hr</span>
              <span>4.0 hrs</span>
            </div>
          </div>

          <div className="ct-roi-field">
            <div className="ct-roi-field-row">
              <label htmlFor={`${baseId}-rate`}>
                Loaded senior engineer hourly cost
              </label>
              <output htmlFor={`${baseId}-rate`}>
                ${inputs.hourlyCostUsd}/hr
              </output>
            </div>
            <input
              id={`${baseId}-rate`}
              type="range"
              min={60}
              max={220}
              step={5}
              value={inputs.hourlyCostUsd}
              onChange={(e) =>
                setInputs((prev) => ({
                  ...prev,
                  hourlyCostUsd: Number(e.target.value),
                }))
              }
            />
            <div className="ct-roi-bounds">
              <span>$60/hr</span>
              <span>$220/hr</span>
            </div>
          </div>
        </div>

        <div className="ct-roi-results">
          <div className="ct-roi-kpis">
            <div className="ct-roi-kpi">
              <span>Engineering hours reclaimed / yr</span>
              <strong data-testid="roi-hours-reclaimed">
                {result.hoursReclaimed} hrs
              </strong>
              <small>
                ~{result.engineeringWeeksEquivalent} engineering weeks saved
              </small>
            </div>
            <div className="ct-roi-kpi">
              <span>Reclaimed capacity value / yr</span>
              <strong data-testid="roi-value-reclaimed">
                {usdFormatter.format(result.reclaimedValueUsd)}
              </strong>
              <small>
                Across {result.totalAssessments} distinct assessments/yr
              </small>
            </div>
            <div className="ct-roi-kpi">
              <span>Wasted onsite panel hrs avoided</span>
              <strong data-testid="roi-onsite-avoided">
                {result.onsiteHoursAvoided} hrs
              </strong>
              <small>
                Assumes 40% early-stage filter efficiency × 3h panel
              </small>
            </div>
          </div>

          <div className="ct-roi-formula" data-testid="roi-formula">
            <strong>Transparent math:</strong> {inputs.targetHires} hires ×{' '}
            {inputs.candidatesPerHire} candidates ={' '}
            <strong>{result.totalAssessments} assessments</strong> ×{' '}
            {inputs.hoursSavedPerCandidate.toFixed(1)} hrs ={' '}
            <strong>{result.hoursReclaimed} hrs</strong> × $
            {inputs.hourlyCostUsd}
            /hr ={' '}
            <strong>{usdFormatter.format(result.reclaimedValueUsd)}/yr</strong>
          </div>

          <div className="ct-roi-recommendation">
            <p>
              <strong>Best fit ({result.tierName}):</strong>{' '}
              {result.tierRationale}
            </p>
            <div
              className="ct-roi-tier-scale"
              aria-label="Tier volume thresholds"
            >
              <span
                className={
                  result.recommendedTier === 'per_candidate' ? 'is-active' : ''
                }
              >
                &le;15/yr: Per Candidate
              </span>
              <span
                className={result.recommendedTier === 'pro' ? 'is-active' : ''}
              >
                16–60/yr: Pro
              </span>
              <span
                className={
                  result.recommendedTier === 'ultra' ? 'is-active' : ''
                }
              >
                &gt;60/yr: Ultra
              </span>
            </div>
          </div>

          <div className="ct-roi-actions">
            <Link className="ct-button" href={ctaHref} prefetch={false}>
              {ctaLabel}
              <Arrow />
            </Link>
            <Link className="ct-inline-link" href="/demo" prefetch={false}>
              Try live reviewer demo <Arrow />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
