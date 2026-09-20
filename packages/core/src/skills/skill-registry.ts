import {
  LocalinkError,
  type SkillDescriptor,
  type SkillManifest,
  type SkillReadReceipt,
} from '@localink/sdk';
import { validateSkillManifest } from '../contracts/validation.js';

export const SKILL_LIMITS = {
  hardReadBytes: 256 * 1024,
  hardAssetBytes: 1024 * 1024,
} as const;

export interface SkillAsset {
  readonly manifest: SkillManifest;
  readonly location: string;
  readonly content: string;
}

interface StoredSkill extends SkillDescriptor {
  readonly content: string;
}

function toDescriptor(skill: StoredSkill): SkillDescriptor {
  return {
    manifest: structuredClone(skill.manifest),
    location: skill.location,
    contentByteLength: skill.contentByteLength,
  };
}

export class SkillRegistry {
  readonly #skills = new Map<string, StoredSkill>();

  register(asset: SkillAsset): SkillDescriptor {
    validateSkillManifest(asset.manifest);
    if (typeof asset.location !== 'string' || asset.location.length === 0) {
      throw new LocalinkError(
        'CONTRACT_INVALID',
        'Skill location is required.',
      );
    }
    if (typeof asset.content !== 'string') {
      throw new LocalinkError(
        'CONTRACT_INVALID',
        'Skill content must be text.',
      );
    }
    const contentByteLength = Buffer.byteLength(asset.content, 'utf8');
    if (contentByteLength > SKILL_LIMITS.hardAssetBytes) {
      throw new LocalinkError(
        'SIZE_LIMIT_EXCEEDED',
        'Skill asset exceeds the registry hard limit.',
        { limit: SKILL_LIMITS.hardAssetBytes },
      );
    }
    if (this.#skills.has(asset.manifest.id)) {
      throw new LocalinkError(
        'ALREADY_EXISTS',
        'Skill is already registered.',
        {
          skillId: asset.manifest.id,
        },
      );
    }
    const stored: StoredSkill = {
      manifest: structuredClone(asset.manifest),
      location: asset.location,
      content: asset.content,
      contentByteLength,
    };
    this.#skills.set(asset.manifest.id, stored);
    return toDescriptor(stored);
  }

  discover(): SkillDescriptor[] {
    return [...this.#skills.values()]
      .map(toDescriptor)
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  }

  list(): SkillDescriptor[] {
    return this.discover();
  }

  search(query = ''): SkillDescriptor[] {
    const normalized = query.trim().toLocaleLowerCase();
    if (normalized.length === 0) return this.discover();
    return this.discover().filter((item) =>
      [
        item.manifest.id,
        item.manifest.title,
        item.manifest.description,
        ...(item.manifest.tags ?? []),
      ].some((value) => value.toLocaleLowerCase().includes(normalized)),
    );
  }

  read(
    skillId: string,
    maxBytes = SKILL_LIMITS.hardReadBytes,
  ): SkillReadReceipt {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > SKILL_LIMITS.hardReadBytes
    ) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Skill read limit is outside the allowed range.',
        { limit: SKILL_LIMITS.hardReadBytes },
      );
    }
    const skill = this.#skills.get(skillId);
    if (skill === undefined) {
      throw new LocalinkError('SKILL_NOT_FOUND', 'Skill was not found.', {
        skillId,
      });
    }
    const source = Buffer.from(skill.content, 'utf8');
    const content =
      source.byteLength <= maxBytes
        ? skill.content
        : source.subarray(0, maxBytes).toString('utf8');
    return {
      ...toDescriptor(skill),
      content,
      returnedByteLength: Buffer.byteLength(content, 'utf8'),
      truncated: source.byteLength > maxBytes,
    };
  }
}
