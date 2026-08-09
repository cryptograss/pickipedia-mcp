/* eslint-disable n/no-missing-import */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Middleware, EditContext } from './types.js';
import { verificationMiddleware } from './verification.js';

/**
 * Middleware pipeline registry.
 *
 * Middlewares are executed in order for onInput (first to last),
 * and in reverse order for onOutput (last to first) - like an onion.
 */
class MiddlewarePipeline {
	private middlewares: Middleware[] = [];

	/**
	 * Add a middleware to the end of the pipeline.
	 *
	 * @param {Middleware} middleware Middleware to append.
	 */
	public register( middleware: Middleware ): void {
		this.middlewares.push( middleware );
		console.error( `[middleware] Registered: ${ middleware.name }` );
	}

	/**
	 * Run all onInput transforms in order.
	 *
	 * @param {EditContext} context Edit about to be sent to the wiki.
	 * @return {Promise<EditContext>} Context after every transform has run.
	 */
	public async processInput( context: EditContext ): Promise<EditContext> {
		let current = context;
		for ( const mw of this.middlewares ) {
			if ( mw.onInput ) {
				current = await mw.onInput( current );
			}
		}
		return current;
	}

	/**
	 * Run all onOutput transforms in reverse order.
	 *
	 * @param {EditContext} context Context the handler ran with.
	 * @param {CallToolResult} result Result returned by the tool handler.
	 * @return {Promise<CallToolResult>} Result after every transform has run.
	 */
	public async processOutput(
		context: EditContext, result: CallToolResult
	): Promise<CallToolResult> {
		let current = result;
		for ( let i = this.middlewares.length - 1; i >= 0; i-- ) {
			const mw = this.middlewares[ i ];
			if ( mw.onOutput ) {
				current = await mw.onOutput( context, current );
			}
		}
		return current;
	}

	/**
	 * Convenience method to wrap a tool handler with middleware.
	 *
	 * @param {EditContext} context Edit to run through the pipeline.
	 * @param {Function} handler Tool handler, called with the transformed context.
	 * @return {Promise<CallToolResult>} Handler's result, transformed on the way out.
	 */
	public async wrapHandler<T extends CallToolResult>(
		context: EditContext,
		handler: ( ctx: EditContext ) => Promise<T>
	): Promise<CallToolResult> {
		const transformedContext = await this.processInput( context );
		const result = await handler( transformedContext );
		return await this.processOutput( transformedContext, result );
	}
}

// Global pipeline instance
export const pipeline = new MiddlewarePipeline();

// Register default middlewares
pipeline.register( verificationMiddleware );

export type { Middleware, EditContext };
