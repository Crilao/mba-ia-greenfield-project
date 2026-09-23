import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1790198954609 implements MigrationInterface {
  name = 'CreateVideos1790198954609';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."video_status" AS ENUM('draft', 'uploading', 'processing', 'ready', 'error')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "channel_id" uuid NOT NULL, "title" character varying(255) NOT NULL DEFAULT '', "description" text, "status" "public"."video_status" NOT NULL DEFAULT 'draft', "slug" character varying(64) NOT NULL, "storage_key" character varying(512), "thumbnail_key" character varying(512), "mime_type" character varying(255) NOT NULL, "size_bytes" bigint NOT NULL DEFAULT '0', "upload_id" character varying(512), "duration_seconds" double precision, "metadata" jsonb, "processing_error" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_5dbcc1ee100f853490582eccc71" UNIQUE ("slug"), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."video_status"`);
  }
}
