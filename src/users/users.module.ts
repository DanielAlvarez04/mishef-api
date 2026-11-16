import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { InvitationsController } from './invitations.controller';
import { PublicInvitationsController } from './public-invitations.controller';
import { InvitationsService } from './invitations.service';

@Module({
  imports: [PrismaModule],
  controllers: [
    UsersController,
    InvitationsController,
    PublicInvitationsController,
  ],
  providers: [UsersService, InvitationsService, JwtAuthGuard, RolesGuard],
  exports: [UsersService],
})
export class UsersModule {}
