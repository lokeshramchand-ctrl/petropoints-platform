import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  adjustRequest,
  earnPointsRequest,
  loginRequest,
  mobile,
  pageQuery,
  redeemPointsRequest,
  refreshRequest,
  registerCustomerRequest,
  reverseRequest,
} from '@petropoints/contracts';
import type {
  EarnPointsRequest,
  LoginRequest,
  PageQuery,
  RedeemPointsRequest,
  RegisterCustomerRequest,
} from '@petropoints/contracts';
import { roleSchema } from '@petropoints/contracts';
import type { Principal } from '@petropoints/rbac';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AdminService } from '../admin/admin.service';
import { AuthService } from '../auth/auth.service';
import type { Db } from '../db/db';
import { LedgerService, type Actor } from '../ledger/ledger.service';
import { verifySlip } from '../ledger/slip';
import { WalletService } from '../wallet/wallet.service';
import { DB, SLIP_SECRET } from './tokens';
import { CurrentUser, IdemKey, Public, Requires, ZodPipe } from './http.support';

const uuidParam = new ParseUUIDPipe({ version: '4' });

/* ============================== health ============================== */

@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready() {
    await this.db.query('SELECT 1');
    return { status: 'ok' };
  }
}

/* ============================== auth ============================== */

@Controller('v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @HttpCode(201)
  register(@Body(new ZodPipe(registerCustomerRequest)) body: RegisterCustomerRequest) {
    return this.auth.registerCustomer(body);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(loginRequest)) body: LoginRequest) {
    const { tokens, principal, name } = await this.auth.login(body);
    return {
      ...tokens,
      user: {
        id: principal.userId,
        name,
        role: principal.role,
        merchantId: principal.merchantId,
        outletId: principal.outletId,
      },
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(new ZodPipe(refreshRequest)) body: { refreshToken: string }) {
    return this.auth.refresh(body.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body(new ZodPipe(refreshRequest)) body: { refreshToken: string }) {
    await this.auth.logout(body.refreshToken);
  }
}

/* ============================== me / wallet ============================== */

@Controller('v1/me')
export class MeController {
  constructor(@Inject(WalletService) private readonly wallet: WalletService) {}

  @Get()
  me(@CurrentUser() p: Principal) {
    return p;
  }

  @Get('wallet')
  @Requires('wallet:read')
  myWallet(@CurrentUser() p: Principal) {
    return this.wallet.myWallet(p);
  }
}

@Controller('v1/transactions')
export class TransactionsController {
  constructor(
    @Inject(WalletService) private readonly wallet: WalletService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(SLIP_SECRET) private readonly slipSecret: string,
  ) {}

  @Get()
  @Requires('transaction:read')
  list(
    @CurrentUser() p: Principal,
    @Query(new ZodPipe(pageQuery.extend({ customerId: z.string().uuid().optional() })))
    q: PageQuery & { customerId?: string },
  ) {
    return this.wallet.history(p, q);
  }

  @Get(':id/slip')
  @Requires('transaction:read')
  slip(@CurrentUser() p: Principal, @Param('id', uuidParam) id: string) {
    return this.ledger.getSlip(p, id);
  }

  @Post(':id/reverse')
  @Requires('points:reverse')
  @HttpCode(201)
  reverse(
    @CurrentUser() p: Principal,
    @IdemKey() key: string,
    @Param('id', uuidParam) id: string,
    @Body(new ZodPipe(reverseRequest)) body: { reason: string },
  ) {
    return this.ledger.reverse(p, key, id, body.reason);
  }

  /** Slip QR verification: proves a printed slip is authentic. Public, reveals nothing but validity. */
  @Public()
  @Post('slips/verify')
  @HttpCode(200)
  verify(
    @Body(
      new ZodPipe(
        z.object({
          slipNumber: z.string(),
          transactionId: z.string().uuid(),
          points: z.number().int(),
          createdAt: z.string().datetime(),
          signature: z.string(),
        }),
      ),
    )
    b: {
      slipNumber: string;
      transactionId: string;
      points: number;
      createdAt: string;
      signature: string;
    },
  ) {
    return { valid: verifySlip(this.slipSecret, b, b.signature) };
  }
}

/* ============================== points ============================== */

@Controller('v1/points')
export class PointsController {
  constructor(
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(WalletService) private readonly wallet: WalletService,
  ) {}

  private async actor(p: Principal, req: FastifyRequest): Promise<Actor> {
    const serial = req.headers['x-device-serial'];
    const deviceId =
      typeof serial === 'string' ? await this.admin.assertDeviceForPrincipal(p, serial) : null;
    return { ...p, deviceId };
  }

  @Get('customers/lookup')
  @Requires('customer:read')
  lookup(@CurrentUser() p: Principal, @Query('mobile', new ZodPipe(mobile)) m: string) {
    return this.wallet.lookupByMobile(p, m);
  }

  @Post('earn')
  @Requires('points:earn')
  @HttpCode(201)
  async earn(
    @CurrentUser() p: Principal,
    @Req() req: FastifyRequest,
    @IdemKey() key: string,
    @Body(new ZodPipe(earnPointsRequest)) body: EarnPointsRequest,
  ) {
    return this.ledger.earn(await this.actor(p, req), key, body);
  }

  @Post('redeem')
  @Requires('points:redeem')
  @HttpCode(201)
  async redeem(
    @CurrentUser() p: Principal,
    @Req() req: FastifyRequest,
    @IdemKey() key: string,
    @Body(new ZodPipe(redeemPointsRequest)) body: RedeemPointsRequest,
  ) {
    return this.ledger.redeem(await this.actor(p, req), key, body);
  }

  @Post('adjust')
  @Requires('points:adjust')
  @HttpCode(201)
  adjust(
    @CurrentUser() p: Principal,
    @IdemKey() key: string,
    @Body(new ZodPipe(adjustRequest)) body: { customerId: string; points: number; reason: string },
  ) {
    return this.ledger.adjust(p, key, body.customerId, body.points, body.reason);
  }
}

/* ============================== back office ============================== */

const createMerchant = z.object({
  name: z.string().trim().min(2).max(120),
  gstin: z
    .string()
    .regex(/^[0-9A-Z]{15}$/)
    .optional(),
});
const createOutlet = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{2,8}$/),
  name: z.string().trim().min(2).max(120),
  city: z.string().trim().max(80).optional(),
});
const createStaff = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(2).max(100),
  role: roleSchema,
  password: z.string().min(10).max(128),
  outletId: z.string().uuid().optional(),
});
const createDevice = z.object({
  serial: z.string().trim().min(4).max(64),
  label: z.string().trim().max(80).optional(),
});
const status = (values: [string, ...string[]]) => z.object({ status: z.enum(values) });

@Controller('v1')
export class BackOfficeController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Post('merchants')
  @HttpCode(201)
  createMerchant(
    @CurrentUser() p: Principal,
    @Body(new ZodPipe(createMerchant)) b: { name: string; gstin?: string },
  ) {
    return this.admin.createMerchant(p, b);
  }

  @Get('merchants')
  merchants(@CurrentUser() p: Principal) {
    return this.admin.listMerchants(p);
  }

  @Patch('merchants/:id/status')
  @HttpCode(204)
  async merchantStatus(
    @CurrentUser() p: Principal,
    @Param('id', uuidParam) id: string,
    @Body(new ZodPipe(status(['ACTIVE', 'SUSPENDED']))) b: { status: 'ACTIVE' | 'SUSPENDED' },
  ) {
    await this.admin.setMerchantStatus(p, id, b.status);
  }

  @Post('merchants/:id/outlets')
  @HttpCode(201)
  createOutlet(
    @CurrentUser() p: Principal,
    @Param('id', uuidParam) id: string,
    @Body(new ZodPipe(createOutlet)) b: { code: string; name: string; city?: string },
  ) {
    return this.admin.createOutlet(p, id, b);
  }

  @Get('merchants/:id/outlets')
  outlets(@CurrentUser() p: Principal, @Param('id', uuidParam) id: string) {
    return this.admin.listOutlets(p, id);
  }

  @Post('merchants/:id/staff')
  @HttpCode(201)
  createStaff(
    @CurrentUser() p: Principal,
    @Param('id', uuidParam) id: string,
    @Body(new ZodPipe(createStaff)) b: z.infer<typeof createStaff>,
  ) {
    return this.admin.createStaff(p, id, b);
  }

  @Get('merchants/:id/staff')
  staff(@CurrentUser() p: Principal, @Param('id', uuidParam) id: string) {
    return this.admin.listStaff(p, id);
  }

  @Patch('staff/:id/status')
  @HttpCode(204)
  async staffStatus(
    @CurrentUser() p: Principal,
    @Param('id', uuidParam) id: string,
    @Body(new ZodPipe(status(['ACTIVE', 'DISABLED']))) b: { status: 'ACTIVE' | 'DISABLED' },
  ) {
    await this.admin.setStaffStatus(p, id, b.status);
  }

  @Post('outlets/:id/devices')
  @HttpCode(201)
  registerDevice(
    @CurrentUser() p: Principal,
    @Param('id', uuidParam) id: string,
    @Body(new ZodPipe(createDevice)) b: { serial: string; label?: string },
  ) {
    return this.admin.registerDevice(p, id, b);
  }

  @Get('outlets/:id/devices')
  devices(@CurrentUser() p: Principal, @Param('id', uuidParam) id: string) {
    return this.admin.listDevices(p, id);
  }

  @Post('devices/:id/revoke')
  @HttpCode(204)
  async revoke(@CurrentUser() p: Principal, @Param('id', uuidParam) id: string) {
    await this.admin.revokeDevice(p, id);
  }

  @Get('merchants/:id/reports/daily')
  @Requires('report:read')
  daily(
    @CurrentUser() p: Principal,
    @Param('id', uuidParam) id: string,
    @Query('days', new ZodPipe(z.coerce.number().int().min(1).max(90).default(30))) days: number,
  ) {
    return this.admin.dailySummary(p, id, days);
  }

  @Get('audit')
  @Requires('audit:read')
  audit(
    @CurrentUser() p: Principal,
    @Query('limit', new ZodPipe(z.coerce.number().int().min(1).max(200).default(50))) limit: number,
  ) {
    return this.admin.auditLog(p, limit);
  }
}
