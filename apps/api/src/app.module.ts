import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AdminService } from './admin/admin.service';
import { AuthService } from './auth/auth.service';
import type { AppConfig } from './config/config';
import type { Db } from './db/db';
import {
  AuthController,
  BackOfficeController,
  HealthController,
  MeController,
  PointsController,
  TransactionsController,
} from './http/controllers';
import { AllExceptionsFilter, AuthGuard } from './http/http.support';
import { DB, SLIP_SECRET } from './http/tokens';
import { LedgerService } from './ledger/ledger.service';
import { WalletService } from './wallet/wallet.service';

@Module({})
export class AppModule {
  /** Dependencies are injected from outside so tests can run the full stack on an in-process database. */
  static register(config: AppConfig, db: Db): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        AuthController,
        MeController,
        TransactionsController,
        PointsController,
        BackOfficeController,
      ],
      providers: [
        { provide: DB, useValue: db },
        { provide: SLIP_SECRET, useValue: config.SLIP_HMAC_SECRET },
        {
          provide: AuthService,
          useValue: new AuthService(db, {
            accessSecret: config.JWT_ACCESS_SECRET,
            accessTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
            refreshTtlSeconds: config.REFRESH_TOKEN_TTL_SECONDS,
          }),
        },
        {
          provide: LedgerService,
          useValue: new LedgerService(db, { slipHmacSecret: config.SLIP_HMAC_SECRET }),
        },
        { provide: WalletService, useValue: new WalletService(db) },
        { provide: AdminService, useValue: new AdminService(db) },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}
