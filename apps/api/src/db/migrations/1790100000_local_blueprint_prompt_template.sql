-- Optio Local automations can run a saved prompt from the Prompts library
-- instead of an inline template.

ALTER TABLE "local_blueprints" ADD COLUMN "prompt_template_id" uuid;
ALTER TABLE "local_blueprints" ADD CONSTRAINT "local_blueprints_prompt_template_id_prompt_templates_id_fk"
  FOREIGN KEY ("prompt_template_id") REFERENCES "public"."prompt_templates"("id") ON DELETE set null ON UPDATE no action;
