import { claudeAnalyzer } from "./analyze.ts";
import { configFromEnv, createHandler } from "./handler.ts";
import { supabaseStore } from "./store.ts";

Deno.serve(createHandler(supabaseStore(), claudeAnalyzer(), configFromEnv()));
