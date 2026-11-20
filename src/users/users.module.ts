import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { PlatformAdminGuard } from '../billing/platform-admin.guard';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PlatformUsersController } from './platform-users.controller';
import { InvitationsController } from './invitations.controller';
import { PublicInvitationsController } from './public-invitations.controller';
import { InvitationsService } from './invitations.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [
    UsersController,
    PlatformUsersController,
    InvitationsController,
    PublicInvitationsController,
  ],
  providers: [
    UsersService,
    InvitationsService,
    JwtAuthGuard,
    RolesGuard,
    PlatformAdminGuard,
  ],
  exports: [UsersService],
})
export class UsersModule {}
