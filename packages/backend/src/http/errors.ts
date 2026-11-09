import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { ErrorBody } from '../contract.js';
import type { MessageParams, MessageRef, Msg } from '../messages.js';

export type { ErrorBody };

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    details?: unknown,
    // the dynamic parts of the message (host, name, number, ...) for clients that translate by code
    readonly params?: MessageParams,
    // set when the text is not the one the code stands for (a wrapper around another error)
    readonly ref?: MessageRef,
  ) {
    super(message);
    this.name = 'AppError';
    // params double as details where there are none, so a client that only reads details finds them as well
    this.details = details ?? params;
  }

  readonly details?: unknown;
}

// The reference of an error: its code is the key, its params the dynamic parts
export const errorRef = (error: AppError): MessageRef =>
  error.ref ?? (error.params === undefined ? { key: error.code } : { key: error.code, params: error.params });

// The message of a failure for a status or job field: the error itself for an AppError, otherwise the fallback
export const errorMsg = (error: unknown, fallback: Msg): Msg =>
  error instanceof AppError ? { text: error.message, ref: errorRef(error) } : fallback;

function body(code: string, message: string, details?: unknown, params?: MessageParams): ErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }), ...(params === undefined ? {} : { params }) } };
}

export function errorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof AppError) {
    void reply.status(error.statusCode).send(body(error.code, error.message, error.details, error.params));
    return;
  }
  if (error instanceof ZodError) {
    void reply.status(400).send(
      body(
        'VALIDATION_ERROR',
        'The request contains invalid data.',
        error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      ),
    );
    return;
  }
  const fastifyError = error as Partial<FastifyError>;
  if (fastifyError.validation !== undefined || fastifyError.statusCode === 400) {
    void reply.status(400).send(body('VALIDATION_ERROR', 'The request contains invalid data.'));
    return;
  }
  if (fastifyError.statusCode === 403) {
    void reply.status(403).send(body('FORBIDDEN', 'Access to this address is not allowed.'));
    return;
  }
  if (fastifyError.statusCode === 413) {
    void reply.status(413).send(body('PAYLOAD_TOO_LARGE', 'The request is too large.'));
    return;
  }
  if (fastifyError.statusCode === 415) {
    void reply.status(415).send(body('UNSUPPORTED_MEDIA_TYPE', 'The content type of the request is not supported.'));
    return;
  }
  request.log.error({ err: error }, 'Unexpected error');
  void reply.status(500).send(body('INTERNAL_ERROR', 'An internal error occurred.'));
}

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
  void reply
    .status(404)
    .send(body('NOT_FOUND', `The resource ${request.method} ${request.url.split('?')[0] ?? ''} was not found.`));
}
