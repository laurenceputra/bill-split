import { describe, expect, it } from 'vitest';
// The worker tsconfig intentionally does not include Node types; this test runs
// in the Node project because it must exercise the real Wrangler migration CLI.
// @ts-expect-error Node types are not shipped to the Worker build.
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
// @ts-expect-error Node types are not shipped to the Worker build.
import { spawnSync } from 'node:child_process';
// @ts-expect-error Node types are not shipped to the Worker build.
import { execPath } from 'node:process';
// @ts-expect-error Node types are not shipped to the Worker build.
import { tmpdir } from 'node:os';
// @ts-expect-error Node types are not shipped to the Worker build.
import { join } from 'node:path';
// @ts-expect-error Node types are not shipped to the Worker build.
import { fileURLToPath } from 'node:url';

type Row = Record<string, unknown>;
const moduleUrl = (import.meta as ImportMeta & { url: string }).url;

describe('scheduled completion migration integration', () => {
  it('upgrades one populated local D1 database and preserves data, compatibility, and integrity', async () => {
    const root = fileURLToPath(new URL('../../', moduleUrl));
    const tempRoot = await mkdtemp(join(tmpdir(), 'bill-split-migration-'));
    const migrationsDir = join(tempRoot, 'migrations');
    const persistDir = join(tempRoot, 'persist');
    const configPath = join(tempRoot, 'wrangler.toml');
    const seedPath = join(tempRoot, 'seed.sql');
    const wrangler = fileURLToPath(new URL('../../node_modules/wrangler/wrangler-dist/cli.js', moduleUrl));
    const beforeNames = [
      '0001_initial.sql', '0002_production_safety.sql', '0003_ledger_total_limits.sql',
      '0004_friend_idempotency_lookup.sql', '0005_clerk_identity.sql',
      '0006_scheduled_expenses.sql', '0007_scheduled_generation_claims.sql',
    ];
    const compatibilityNames = [
      '0008_scheduled_expense_completion.sql', '0009_scheduled_generation_cursor.sql',
      '0010_generated_expense_operation_namespace.sql', '0011_scheduled_expense_category.sql',
      '0012_invitations_audit_purge.sql', '0013_projection_layer.sql',
      '0014_projection_indexes.sql', '0015_audit_actor_snapshot.sql',
      '0016_projection_readiness_reset.sql', '0017_cleanup_indexes.sql',
      '0018_category_preferences.sql', '0019_group_membership_events.sql',
      '0020_account_deletion.sql', '0021_deleted_identity_tombstones.sql',
      '0022_application_sessions.sql', '0023_group_split_defaults.sql',
    ];
    const currentNames = [
      '0024_incremental_projection_totals.sql', '0025_expense_suggestion_lookup.sql',
      '0026_targeted_group_invitations.sql', '0027_profile_revision.sql', '0028_group_kind.sql', '0029_bidirectional_group_kind_guards.sql',
    ];
    const preKindNames = currentNames.slice(0, -2);
    const seed = `
      INSERT INTO users(id,email,created_at,updated_at) VALUES('user-1','migration@example.com','2026-01-01','2026-01-01');
      INSERT INTO people(id,name,email,user_id,created_at) VALUES('person-1','Migration User','migration@example.com','user-1','2026-01-01');
       INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES
         ('group-1','Migration Group','USD','2026-01-01','2026-01-01'),
         ('group-multiple','Multiple Owners','USD','2026-01-01','2026-01-01'),
         ('group-ownerless','Ownerless Group','USD','2026-01-01','2026-01-01');
      INSERT INTO group_members(group_id,person_id,user_id,joined_at,role) VALUES('group-1','person-1','user-1','2026-01-01','owner');
      INSERT INTO people(id,name,email,created_at) VALUES
        ('person-2','Second','second@example.com','2026-01-01'),
        ('person-3','Third','third@example.com','2026-01-01'),
        ('person-4','Fourth','fourth@example.com','2026-01-01');
       INSERT INTO group_members(group_id,person_id,joined_at,role) VALUES
         ('group-multiple','person-3','2026-01-03','owner'),
         ('group-multiple','person-2','2026-01-03','owner'),
         ('group-multiple','person-4','2026-01-04','member'),
         ('group-ownerless','person-4','2026-01-02','member'),
         ('group-ownerless','person-3','2026-01-01','member');
       INSERT INTO idempotency_keys(kind,user_id,group_id,operation_id,request_hash,entity_id,created_at) VALUES
         ('friend.create','user-1','group-multiple','legacy-large-friend','hash-large','group-multiple','2026-01-01'),
         ('friend.create','user-1','group-ownerless','legacy-friend','hash','group-ownerless','2026-01-01');
      INSERT INTO expenses(id,group_id,description,amount_minor,currency,expense_date,category,created_by,created_at,updated_at,version) VALUES
        ('expense-1','group-1','ÉCLAIR',1000,'USD','2026-01-01','Dining','user-1','2026-01-01','2026-01-01',1),
        ('expense-2','group-1','Éclair',500,'USD','2026-01-02','Dessert','user-1','2026-01-02','2026-01-02',1);
      INSERT INTO payers(expense_id,person_id,amount_minor) VALUES('expense-1','person-1',1000);
      INSERT INTO splits(expense_id,person_id,amount_minor) VALUES('expense-1','person-1',1000);
      INSERT INTO scheduled_expenses(id,group_id,description,amount_minor,currency,start_date,end_date,frequency,interval_count,weekdays_json,timezone,status,blocked_reason,next_occurrence_date,created_by,created_at,updated_at,version,client_operation_id,generation_claim_id)
        VALUES('scheduled-1','group-1','Existing schedule',1000,'USD','2026-01-01',NULL,'monthly',1,'[]','UTC','active',NULL,'2026-02-01','user-1','2026-01-01','2026-01-01',3,NULL,'claim-1');
      INSERT INTO scheduled_payers(scheduled_expense_id,person_id,amount_minor) VALUES('scheduled-1','person-1',1000);
      INSERT INTO scheduled_splits(scheduled_expense_id,person_id,amount_minor,metadata_json) VALUES('scheduled-1','person-1',1000,NULL);
      INSERT INTO scheduled_occurrences(scheduled_expense_id,occurrence_date,expense_id,created_at) VALUES('scheduled-1','2026-01-01','expense-1','2026-01-01');
    `;
    const run = (args: string[]) => {
      const result = spawnSync(execPath, ['--no-warnings', '--experimental-vm-modules', wrangler, ...args], { cwd: tempRoot, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`Wrangler failed (${result.status}): ${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    const runRaw = (args: string[]) => spawnSync(execPath, ['--no-warnings', '--experimental-vm-modules', wrangler, ...args], { cwd: tempRoot, encoding: 'utf8' });
    const querySets = (sql: string) => {
      const parsed = JSON.parse(run(['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', sql, '--yes', '--json'])) as Array<{ results?: Row[] }>;
      return parsed.map((result) => result.results ?? []);
    };

    try {
      await mkdir(migrationsDir, { recursive: true });
      await Promise.all(beforeNames.map((name) => cp(join(root, 'migrations', name), join(migrationsDir, name))));
      await writeFile(configPath, `name = "bill-split-migration-test"\ncompatibility_date = "2025-08-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "bill-split-migration"\ndatabase_id = "00000000-0000-4000-8000-000000000002"\nmigrations_dir = "migrations"\n`);
      await writeFile(seedPath, seed);
      run(['d1', 'migrations', 'apply', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath]);
      run(['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--file', seedPath]);

      await Promise.all(compatibilityNames.map((name) => cp(join(root, 'migrations', name), join(migrationsDir, name))));
      run(['d1', 'migrations', 'apply', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath]);
      run(['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', "UPDATE projection_state SET status='ready' WHERE group_id='group-1'; INSERT INTO group_balance_projection(group_id,currency,person_id,net_minor,updated_at) VALUES('group-1','USD','person-1',100,'2026-01-01');", '--yes']);
       await Promise.all(preKindNames.map((name) => cp(join(root, 'migrations', name), join(migrationsDir, name))));
       run(['d1', 'migrations', 'apply', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath]);
       run(['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', "INSERT INTO group_invitations(id,group_id,email_normalized,created_by,created_at,expires_at) VALUES('legacy-generic','group-ownerless','legacy@example.com','user-1','2026-01-01','9999-01-01');", '--yes']);
        await cp(join(root, 'migrations', '0028_group_kind.sql'), join(migrationsDir, '0028_group_kind.sql'));
        run(['d1', 'migrations', 'apply', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath]);
        run(['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', "INSERT INTO group_invitations(id,group_id,email_normalized,created_by,created_at,expires_at) VALUES('upgrade-generic','group-ownerless','upgrade@example.com','user-1','2026-01-02','9999-01-01'); INSERT INTO group_invitations(id,group_id,email_normalized,created_by,created_at,expires_at,target_person_id) VALUES('upgrade-targeted','group-ownerless','fourth@example.com','user-1','2026-01-02','9999-01-01','person-4');", '--yes']);
        await cp(join(root, 'migrations', '0029_bidirectional_group_kind_guards.sql'), join(migrationsDir, '0029_bidirectional_group_kind_guards.sql'));
        run(['d1', 'migrations', 'apply', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath]);

      const [scheduled, cursor, preferences, owners, projection, summary, legacy, auditColumns, userColumns, targetColumns, targetIndexes, occurrenceForeignKeys, suggestionPlan, purgePlan, groupKinds, peerTriggers, legacyInvitation, upgradeWindowInvitations] = querySets(`
        SELECT id,status,generation_claim_id,next_occurrence_date,
          (SELECT COUNT(*) FROM scheduled_payers WHERE scheduled_expense_id=scheduled_expenses.id) AS payer_count,
          (SELECT COUNT(*) FROM scheduled_splits WHERE scheduled_expense_id=scheduled_expenses.id) AS split_count,
          (SELECT COUNT(*) FROM scheduled_occurrences WHERE scheduled_expense_id=scheduled_expenses.id) AS occurrence_count
          FROM scheduled_expenses WHERE id='scheduled-1';
        SELECT cursor_id FROM scheduled_generation_cursor WHERE id=1;
        SELECT user_id,normalized_description,category FROM category_preferences;
        SELECT group_id,person_id,role FROM group_members WHERE group_id IN ('group-multiple','group-ownerless') AND role='owner' ORDER BY group_id,person_id;
        SELECT group_id,status,ledger_totals_ready,reconciliation_due FROM projection_state WHERE group_id IN ('group-1','group-multiple','group-ownerless') ORDER BY group_id;
        SELECT group_id,maintenance_due FROM ledger_summary_state ORDER BY group_id;
        SELECT group_id,currency,person_id,net_minor FROM group_balance_projection;
        SELECT name FROM pragma_table_info('audit_events') WHERE name IN ('actor_person_id','actor_name') ORDER BY name;
         SELECT name FROM pragma_table_info('users') WHERE name IN ('deleted_at','deleted_email_hash','deleted_clerk_hash','profile_revision') ORDER BY name;
        SELECT name FROM pragma_table_info('group_invitations') WHERE name='target_person_id';
        SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_group_invitations_target','idx_group_invitations_pending_target','idx_group_invitations_pending_email') ORDER BY name;
        PRAGMA foreign_key_list(scheduled_occurrences);
        EXPLAIN QUERY PLAN SELECT e.id FROM expenses e
          WHERE e.group_id='group-1' AND e.created_by='user-1' AND e.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM scheduled_occurrences occurrence WHERE occurrence.expense_id=e.id)
          ORDER BY e.created_at DESC,e.id DESC LIMIT 3;
        EXPLAIN QUERY PLAN SELECT id,deleted_at FROM groups
          WHERE deleted_at IS NOT NULL AND deleted_at<'2026-02-01'
          ORDER BY deleted_at,id LIMIT 1;
       SELECT id,kind,(SELECT COUNT(*) FROM group_members gm WHERE gm.group_id=groups.id AND gm.deleted_at IS NULL) AS active_members FROM groups WHERE id IN ('group-multiple','group-ownerless') ORDER BY id;
         SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('peer_group_generic_invitation_guard','peer_group_generic_invitation_update_guard','peer_group_kind_eligibility','peer_group_member_limit_insert','peer_group_member_limit_update','peer_group_kind_limit','peer_group_targeted_invitation_update_guard','targeted_invitation_account_guard','targeted_invitation_account_update_guard') ORDER BY name;
        SELECT id,revoked_at FROM group_invitations WHERE id='legacy-generic';
        SELECT id,target_person_id,revoked_at,accepted_at,rejected_at FROM group_invitations WHERE id IN ('upgrade-generic','upgrade-targeted') ORDER BY id;
        `);
      expect(scheduled).toEqual([{ id: 'scheduled-1', status: 'active', generation_claim_id: 'claim-1', next_occurrence_date: '2026-02-01', payer_count: 1, split_count: 1, occurrence_count: 1 }]);
      expect(cursor).toEqual([{ cursor_id: null }]);
      expect(preferences).toEqual([{ user_id: 'user-1', normalized_description: 'Éclair', category: 'Dessert' }]);
      expect(owners).toEqual([
        { group_id: 'group-multiple', person_id: 'person-2', role: 'owner' },
        { group_id: 'group-ownerless', person_id: 'person-3', role: 'owner' },
      ]);
      expect(projection).toEqual([
        { group_id: 'group-1', status: 'ready', ledger_totals_ready: 0, reconciliation_due: 0 },
        { group_id: 'group-multiple', status: 'pending', ledger_totals_ready: 0, reconciliation_due: 0 },
        { group_id: 'group-ownerless', status: 'pending', ledger_totals_ready: 0, reconciliation_due: 0 },
      ]);
      expect(summary).toEqual([
        { group_id: 'group-1', maintenance_due: 1 },
        { group_id: 'group-multiple', maintenance_due: 1 },
        { group_id: 'group-ownerless', maintenance_due: 1 },
      ]);
      expect(legacy).toEqual([{ group_id: 'group-1', currency: 'USD', person_id: 'person-1', net_minor: 100 }]);
      expect(auditColumns).toEqual([{ name: 'actor_name' }, { name: 'actor_person_id' }]);
       expect(userColumns).toEqual([{ name: 'deleted_at' }, { name: 'deleted_clerk_hash' }, { name: 'deleted_email_hash' }, { name: 'profile_revision' }]);
      expect(targetColumns).toEqual([{ name: 'target_person_id' }]);
       expect(targetIndexes).toEqual([{ name: 'idx_group_invitations_pending_email' }, { name: 'idx_group_invitations_pending_target' }, { name: 'idx_group_invitations_target' }]);
       expect(groupKinds).toEqual([{ id: 'group-multiple', kind: 'named', active_members: 3 }, { id: 'group-ownerless', kind: 'peer', active_members: 2 }]);
        expect(peerTriggers).toEqual([{ name: 'peer_group_generic_invitation_guard' }, { name: 'peer_group_generic_invitation_update_guard' }, { name: 'peer_group_kind_eligibility' }, { name: 'peer_group_kind_limit' }, { name: 'peer_group_member_limit_insert' }, { name: 'peer_group_member_limit_update' }, { name: 'peer_group_targeted_invitation_update_guard' }, { name: 'targeted_invitation_account_guard' }, { name: 'targeted_invitation_account_update_guard' }]);
        expect(legacyInvitation).toEqual([{ id: 'legacy-generic', revoked_at: expect.any(String) }]);
        expect(upgradeWindowInvitations).toEqual([
          { id: 'upgrade-generic', target_person_id: null, revoked_at: expect.any(String), accepted_at: null, rejected_at: null },
          { id: 'upgrade-targeted', target_person_id: 'person-4', revoked_at: null, accepted_at: null, rejected_at: null },
        ]);
       const blockedPeerInsert = runRaw(['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', "INSERT INTO group_members(group_id,person_id,joined_at,role) VALUES('group-ownerless','person-1','2026-01-05','member');", '--yes']);
       expect(blockedPeerInsert.status).not.toBe(0);
       run(['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', "INSERT INTO group_members(group_id,person_id,joined_at,deleted_at,role) VALUES('group-ownerless','person-1','2026-01-05','2026-01-06','member');", '--yes']);
        const blockedPeerReactivation = runRaw(['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', "UPDATE group_members SET deleted_at=NULL WHERE group_id='group-ownerless' AND person_id='person-1';", '--yes']);
        expect(blockedPeerReactivation.status).not.toBe(0);
        const blockedPeerKindConversion = runRaw(['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', "UPDATE groups SET kind='peer' WHERE id='group-multiple';", '--yes']);
        expect(blockedPeerKindConversion.status).not.toBe(0);
        const [preservedNamedGroup] = querySets("SELECT kind FROM groups WHERE id='group-multiple';");
        expect(preservedNamedGroup).toEqual([{ kind: 'named' }]);
        run(['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', "INSERT INTO users(id,email,created_at,updated_at) VALUES('user-linked','linked@example.com','2026-01-01','2026-01-01'); INSERT INTO people(id,name,email,user_id,created_at) VALUES('person-linked','Linked Account','linked@example.com','user-linked','2026-01-01');", '--yes']);
        const blockedTargetedInsert = runRaw(['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', "INSERT INTO group_invitations(id,group_id,email_normalized,created_by,created_at,expires_at,target_person_id) VALUES('wrong-target','group-ownerless','wrong@example.com','user-1','2026-01-07','9999-01-01','person-linked');", '--yes']);
        expect(blockedTargetedInsert.status).not.toBe(0);
        const [rolledBackTargetedInsert] = querySets("SELECT id FROM group_invitations WHERE id='wrong-target';");
        expect(rolledBackTargetedInsert).toEqual([]);
        run(['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', "INSERT INTO group_invitations(id,group_id,email_normalized,created_by,created_at,expires_at,target_person_id) VALUES('right-target','group-ownerless','linked@example.com','user-1','2026-01-07','9999-01-01','person-linked');", '--yes']);
        const [acceptedTargetedInsert] = querySets("SELECT id,email_normalized,target_person_id FROM group_invitations WHERE id='right-target';");
        expect(acceptedTargetedInsert).toEqual([{ id: 'right-target', email_normalized: 'linked@example.com', target_person_id: 'person-linked' }]);
       expect(occurrenceForeignKeys).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'scheduled_expenses' })]));
      expect(JSON.stringify(suggestionPlan).toLowerCase()).toContain('idx_expenses_suggestion_lookup');
      expect(JSON.stringify(purgePlan).toLowerCase()).toContain('idx_groups_deleted_purge');

      run(['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', "UPDATE expenses SET currency='EUR' WHERE id='expense-2'; UPDATE expenses SET deleted_at='2026-01-03' WHERE id='expense-1'; UPDATE expenses SET deleted_at=NULL WHERE id='expense-1'; DELETE FROM expenses WHERE id='expense-2';", '--yes']);
      const [mutationSummary, mutationTotals, mutationLegacy] = querySets(`
        SELECT status,maintenance_due FROM ledger_summary_state WHERE group_id='group-1';
        SELECT group_id,currency,gross_minor FROM ledger_totals;
        SELECT group_id,currency,person_id,net_minor FROM group_balance_projection;
      `);
      expect(mutationSummary).toEqual([{ status: 'dirty', maintenance_due: 1 }]);
      expect(mutationTotals).toEqual([]);
      expect(mutationLegacy).toEqual([{ group_id: 'group-1', currency: 'USD', person_id: 'person-1', net_minor: 100 }]);

      run(['d1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', `INSERT INTO group_split_defaults(group_id,method,person_ids_json,values_json,updated_at) VALUES('group-1','equal','["person-1"]',NULL,'2026-01-01'); UPDATE groups SET deleted_at='2026-02-01' WHERE id='group-1';`, '--yes']);
      const [defaultRows, foreignKeyRows] = querySets("SELECT group_id FROM group_split_defaults WHERE group_id='group-1'; PRAGMA foreign_key_check;");
      expect(defaultRows).toEqual([]);
      expect(foreignKeyRows).toEqual([]);

      const invalidChild = spawnSync(execPath, ['--no-warnings', '--experimental-vm-modules', wrangler, 'd1', 'execute', 'bill-split-migration', '--local', '--persist-to', persistDir, '--config', configPath, '--command', "INSERT INTO scheduled_payers(scheduled_expense_id,person_id,amount_minor) VALUES('missing-schedule','person-1',1);", '--yes'], { cwd: tempRoot, encoding: 'utf8' });
      expect(invalidChild.status).not.toBe(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 300_000);
});
