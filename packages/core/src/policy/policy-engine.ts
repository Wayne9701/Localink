import {
  LocalinkError,
  type CapabilityDescriptor,
  type PolicyAction,
  type PolicyDecision,
  type PolicyProfile,
  type PolicyProfileName,
  type RiskTier,
  type WorkspacePolicyOverride,
} from '@localink/sdk';

export const POLICY_PROFILES: Readonly<
  Record<PolicyProfileName, PolicyProfile>
> = {
  open: {
    name: 'open',
    decisions: { 0: 'allow', 1: 'allow', 2: 'allow', 3: 'deny' },
  },
  balanced: {
    name: 'balanced',
    decisions: { 0: 'allow', 1: 'allow', 2: 'confirm', 3: 'deny' },
  },
  strict: {
    name: 'strict',
    decisions: { 0: 'allow', 1: 'confirm', 2: 'confirm', 3: 'deny' },
  },
};

function assertAction(value: unknown): asserts value is PolicyAction {
  if (!['allow', 'confirm', 'deny'].includes(String(value))) {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      'Workspace policy override contains an invalid action.',
    );
  }
}

function overrideFor(
  override: WorkspacePolicyOverride | undefined,
  tier: RiskTier,
): PolicyAction | undefined {
  const action = override?.decisions?.[tier];
  if (action !== undefined) assertAction(action);
  return action;
}

export class PolicyEngine {
  evaluate(
    descriptor: CapabilityDescriptor,
    profileName: PolicyProfileName,
    override?: WorkspacePolicyOverride,
  ): PolicyDecision {
    const profile = POLICY_PROFILES[profileName];
    if (profile === undefined) {
      throw new LocalinkError('CONTRACT_INVALID', 'Policy profile is invalid.');
    }

    const tier = descriptor.riskTier;
    const requestedOverride = overrideFor(override, tier);
    const protectedBoundary = tier === 3;
    const overrideApplied =
      !protectedBoundary && requestedOverride !== undefined;
    const action = protectedBoundary
      ? 'deny'
      : (requestedOverride ?? profile.decisions[tier]);

    const code = protectedBoundary
      ? 'POLICY_TIER3_PROTECTED'
      : overrideApplied
        ? 'POLICY_WORKSPACE_OVERRIDE'
        : `POLICY_${profileName.toUpperCase()}_TIER_${tier}_${action.toUpperCase()}`;
    const message = protectedBoundary
      ? 'Tier 3 is protected and cannot be opened by a profile or workspace override.'
      : overrideApplied
        ? `Workspace policy override selected ${action}.`
        : `${profileName} policy selected ${action} for Tier ${tier}.`;

    return {
      action,
      profile: profileName,
      tier,
      reason: { code, message },
      workspaceOverrideApplied: overrideApplied,
    };
  }
}
