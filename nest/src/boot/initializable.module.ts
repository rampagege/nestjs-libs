import { Trace } from '@app/nest/trace';
import { getAppLogger } from '@app/utils/app-logger';

import { Temporal } from '@js-temporal/polyfill';

import type { Logger } from '@app/utils/app-logger';
import type { OnApplicationBootstrap, OnApplicationShutdown, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

export interface InitializationOptions {
  timeout?: number;
  moduleName?: string;
}

export abstract class InitializableModule
  implements OnModuleInit, OnModuleDestroy, OnApplicationBootstrap, OnApplicationShutdown
{
  protected readonly logger: Logger;
  protected readonly startTime: Temporal.Instant;
  protected readonly timeout: number;
  protected readonly moduleName: string;

  constructor(options: InitializationOptions = {}) {
    this.timeout = options.timeout ?? 30;
    this.moduleName = options.moduleName ?? this.constructor.name;
    this.logger = getAppLogger(this.moduleName);
    this.startTime = Temporal.Now.instant();
  }

  @Trace()
  async onModuleInit() {
    if (this.initialize === InitializableModule.prototype.initialize) {
      this.logger.debug`#onModuleInit initialized`;
      return;
    }

    this.logger.debug`#initialize initializing...`;

    try {
      // 设置超时检查
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              `Initialization timeout, over ${this.timeout.toLocaleString()}s, set larger timeout in domain constructor.`,
            ),
          );
        }, this.timeout * 1000);
      });

      // 等待初始化完成或超时
      await Promise.race([this.initialize(), timeoutPromise]);

      const duration = this.startTime.until(Temporal.Now.instant(), {
        largestUnit: 'hours',
        smallestUnit: 'milliseconds',
      });

      this.logger.debug`#initialize initialized in ${duration.toLocaleString('en')}`;
    } catch (error: unknown) {
      this.logger.error`#initialize failed: ${error}`;
      throw error;
    }
  }

  protected async initialize(): Promise<void> {}
  protected async onDispose(): Promise<void> {}

  private destroying = false;

  @Trace()
  async onModuleDestroy() {
    if (this.onDispose === InitializableModule.prototype.onDispose) {
      return;
    }
    if (this.destroying) {
      return;
    }
    this.destroying = true;
    this.logger.debug`#onDispose destroying ...`;
    await this.onDispose();
    this.logger.debug`#onDispose disposed.`;
  }

  @Trace()
  async onApplicationBootstrap() {
    // 检查子类是否实现了 onBootstrap
    if (this.onBootstrap === InitializableModule.prototype.onBootstrap) {
      return;
    }

    const startTime = Temporal.Now.instant();
    this.logger.debug`#onBootstrap bootstraping...`;
    await this.onBootstrap();
    const duration = startTime.until(Temporal.Now.instant(), {
      largestUnit: 'hours',
      smallestUnit: 'milliseconds',
    });
    this.logger.debug`#onBootstrap bootstraped in ${duration.toLocaleString('en')}`;
  }

  protected async onBootstrap(): Promise<void> {
    /* 默认空实现 */
  }

  @Trace()
  async onApplicationShutdown(signal?: string) {
    // 检查子类是否实现了 onBootstrap
    if (this.onShutdown === InitializableModule.prototype.onShutdown) {
      return;
    }

    const startTime = Temporal.Now.instant();
    this.logger.debug`#onShutdown shutting down... ${{ signal }}`;
    await this.onShutdown();
    const duration = startTime.until(Temporal.Now.instant(), {
      largestUnit: 'hours',
      smallestUnit: 'milliseconds',
    });
    this.logger.debug`#onShutdown shut down in ${duration.toLocaleString('en')}`;
  }

  protected async onShutdown() {
    /* 默认空实现 */
  }
}
