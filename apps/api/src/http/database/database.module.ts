import { Global, Module } from '@nestjs/common';
import { DatabaseService } from '@modules/shared/database/database.service';

@Global()
@Module({
  providers: [
    { provide: DatabaseService, useFactory: () => new DatabaseService() },
  ],
  exports: [DatabaseService],
})
export class DatabaseModule {}
