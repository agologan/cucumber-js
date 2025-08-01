import { EventEmitter } from 'node:events'
import { promisify } from 'node:util'
import { WriteStream as TtyWriteStream } from 'node:tty'
import { IFormatterStream } from '../formatter'
import { EventDataCollector } from '../formatter/helpers'
import { SupportCodeLibrary } from '../support_code_library_builder/types'
import FormatterBuilder from '../formatter/builder'
import { ILogger } from '../environment'
import { createStream } from '../formatter/create_stream'
import { resolveImplementation } from '../formatter/resolve_implementation'
import { PluginManager } from '../plugin'
import { IRunOptionsFormats } from './types'

export async function initializeFormatters({
  env,
  cwd,
  stdout,
  logger,
  onStreamError,
  eventBroadcaster,
  eventDataCollector,
  configuration,
  supportCodeLibrary,
  pluginManager,
}: {
  env: NodeJS.ProcessEnv
  cwd: string
  stdout: IFormatterStream
  stderr: IFormatterStream
  logger: ILogger
  onStreamError: () => void
  eventBroadcaster: EventEmitter
  eventDataCollector: EventDataCollector
  configuration: IRunOptionsFormats
  supportCodeLibrary: SupportCodeLibrary
  pluginManager: PluginManager
}): Promise<() => Promise<void>> {
  const cleanupFns: Array<() => Promise<void>> = []

  async function initializeFormatter(
    stream: IFormatterStream,
    directory: string | undefined,
    target: string,
    specifier: string
  ): Promise<void> {
    if (specifier === 'progress-bar' && !(stream as TtyWriteStream).isTTY) {
      logger.warn(
        `Cannot use 'progress-bar' formatter for output to '${target}' as not a TTY. Switching to 'progress' formatter.`
      )
      specifier = 'progress'
    }
    const implementation = await resolveImplementation(specifier, cwd)
    if (typeof implementation === 'function') {
      const typeOptions = {
        env,
        cwd,
        eventBroadcaster,
        eventDataCollector,
        log: stream.write.bind(stream),
        parsedArgvOptions: configuration.options,
        stream,
        cleanup:
          stream === stdout
            ? async () => await Promise.resolve()
            : promisify<any>(stream.end.bind(stream)),
        supportCodeLibrary,
      }
      const formatter = await FormatterBuilder.build(
        implementation,
        typeOptions
      )
      cleanupFns.push(async () => formatter.finished())
    } else {
      await pluginManager.initFormatter(
        implementation,
        configuration.options,
        stream,
        stream.write.bind(stream),
        directory
      )
      if (stream !== stdout) {
        cleanupFns.push(promisify<any>(stream.end.bind(stream)))
      }
    }
  }

  await initializeFormatter(stdout, undefined, 'stdout', configuration.stdout)
  for (const [target, specifier] of Object.entries(configuration.files)) {
    const { stream, directory } = await createStream(
      target,
      onStreamError,
      cwd,
      logger
    )
    await initializeFormatter(stream, directory, target, specifier)
  }

  return async function () {
    await Promise.all(cleanupFns.map((cleanupFn) => cleanupFn()))
  }
}
