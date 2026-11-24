import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  Optional,
  Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, ROLES_KEY } from './decorators.js';

export const AUTH_CONTEXT_RESOLVER = 'AUTH_CONTEXT_RESOLVER';

export interface AuthenticatedUserContext {
  workspaceId: string;
  actorId: string;
  roles?: string[];
}

export interface AuthContextResolver {
  resolve(
    context: ExecutionContext,
  ): Promise<AuthenticatedUserContext | null> | AuthenticatedUserContext | null;
}

export interface AuthenticatedContextRequest {
  workspaceId?: string;
  actorId?: string;
  roles?: string[];
  authContext?: AuthenticatedUserContext;
  headers: Record<string, string | undefined>;
}

@Injectable()
export class AuthBoundaryGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional()
    @Inject(AUTH_CONTEXT_RESOLVER)
    private readonly contextResolver?: AuthContextResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const nodeEnv = process.env['NODE_ENV'] ?? 'development';

    // In production, real authentication is gated pending Stage 4C.2
    if (nodeEnv === 'production') {
      throw new ForbiddenException(
        'Public CRUD routes disabled. Production authentication integration is scheduled for Stage 4C.2.',
      );
    }

    const request = context.switchToHttp().getRequest<AuthenticatedContextRequest>();

    // Strict Security Gate: Never trust forged or arbitrary x-test-* request headers off the wire.
    if (
      request.headers &&
      (request.headers['x-test-workspace-id'] ||
        request.headers['x-test-actor-id'] ||
        request.headers['x-test-roles'])
    ) {
      throw new UnauthorizedException(
        'Arbitrary test identity headers are strictly prohibited in application runtime. Authentication required.',
      );
    }

    // Resolve identity through controlled dependency-injected test/auth resolver or pre-attached authContext
    const resolvedContext =
      request.authContext ?? (this.contextResolver ? await this.contextResolver.resolve(context) : null);

    if (!resolvedContext || !resolvedContext.workspaceId || !resolvedContext.actorId) {
      throw new UnauthorizedException(
        'Missing workspace or actor authorization context. Access denied by default.',
      );
    }

    const roles =
      resolvedContext.roles && resolvedContext.roles.length > 0
        ? resolvedContext.roles.map((r) => r.trim().toUpperCase())
        : ['MEMBER'];

    request.workspaceId = resolvedContext.workspaceId;
    request.actorId = resolvedContext.actorId;
    request.roles = roles;

    // Check role requirements if specified
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredRoles && requiredRoles.length > 0) {
      const hasRole = requiredRoles.some((role) => roles.includes(role.toUpperCase()));
      if (!hasRole) {
        throw new ForbiddenException(
          `Insufficient workspace permissions. Required one of: ${requiredRoles.join(', ')}`,
        );
      }
    }

    return true;
  }
}
