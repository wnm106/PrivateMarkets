import type { Context } from '../context';
import {
  activeCertification,
  certificationHistory,
  certificationsById,
  certify,
  revokeCertification,
  type Certification,
  type CertifyInput,
} from '../lib/certification-store';

export const certificationResolvers = {
  Query: {
    certification: async (
      _: unknown,
      args: { processCode: string; subjectEntityId: string; periodEnd?: string | null },
      context: Context,
    ) => activeCertification(context.supabase, args.processCode, args.subjectEntityId, args.periodEnd),
    certificationHistory: async (
      _: unknown,
      args: { subjectEntityId: string; processCode?: string | null },
      context: Context,
    ) => certificationHistory(context.supabase, args.subjectEntityId, args.processCode),
  },
  Mutation: {
    certify: async (_: unknown, args: { input: CertifyInput }, context: Context) => certify(context.supabase, args.input),
    revokeCertification: async (_: unknown, args: { id: string; reason?: string | null }, context: Context) =>
      revokeCertification(context.supabase, args.id, args.reason),
  },
  Certification: {
    /** The certifications this one was read against, as they stand now: a revoked one has been replaced since. */
    dependencies: async (parent: Certification, _: unknown, context: Context) =>
      certificationsById(context.supabase, parent.dependsOn || []),
  },
};
