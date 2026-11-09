// One server-side operation per provider response keeps free-hosted imports practical.
export const ingestionSchema = `
CREATE FUNCTION __SCHEMA__.ingest_football(p_raw_id text,p_provider text,p_captured text,p_raw text,p_rows jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = __SCHEMA__, pg_catalog, pg_temp AS $ingest$
DECLARE item jsonb; f jsonb; current_payload text; current_fixture jsonb; revision bigint; side_index integer;
  team_id text; stat_id text;
BEGIN
  INSERT INTO raw_observations(id,provider,captured_at,payload) VALUES(p_raw_id,p_provider,p_captured,p_raw) ON CONFLICT DO NOTHING;
  FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    f := (item->>'payload')::jsonb;
    current_payload := NULL;
    SELECT payload INTO current_payload FROM fixtures WHERE id=f->>'id';
    current_fixture := current_payload::jsonb;
    IF current_fixture->>'provider'='football-data' AND f->>'provider'='openfootball' THEN CONTINUE; END IF;
    IF current_fixture IS NOT NULL AND (current_fixture-'observedAt')=(f-'observedAt') THEN
      SELECT revision_id INTO revision FROM fixture_revisions WHERE id=f->>'id' AND payload=current_payload ORDER BY revision_id DESC LIMIT 1;
      INSERT INTO fixture_provenance(fixture_revision_id,raw_observation_id) VALUES(revision,p_raw_id) ON CONFLICT DO NOTHING;
      CONTINUE;
    END IF;
    INSERT INTO fixture_revisions(id,observed_at,payload) VALUES(f->>'id',f->>'observedAt',item->>'payload') ON CONFLICT DO NOTHING;
    SELECT revision_id INTO revision FROM fixture_revisions WHERE id=f->>'id' AND payload=item->>'payload' ORDER BY revision_id DESC LIMIT 1;
    IF current_fixture IS NULL OR current_fixture->>'observedAt'<=f->>'observedAt' THEN
      INSERT INTO fixtures(id,payload) VALUES(f->>'id',item->>'payload') ON CONFLICT(id) DO UPDATE SET payload=excluded.payload;
    END IF;
    INSERT INTO competitions(id,name) VALUES(f->>'competition',item->>'competitionName') ON CONFLICT DO NOTHING;
    INSERT INTO seasons(id,competition_id,label) VALUES(item->>'seasonId',f->>'competition',f->>'season') ON CONFLICT DO NOTHING;
    INSERT INTO teams(id,competition_id,canonical_key,display_name) VALUES(item->>'homeId',f->>'competition',f->>'homeKey',f->>'home') ON CONFLICT DO NOTHING;
    INSERT INTO teams(id,competition_id,canonical_key,display_name) VALUES(item->>'awayId',f->>'competition',f->>'awayKey',f->>'away') ON CONFLICT DO NOTHING;
    INSERT INTO fixture_catalog(id,season_id,home_team_id,away_team_id,kickoff,date_only,provider,current_revision_id)
      VALUES(f->>'id',item->>'seasonId',item->>'homeId',item->>'awayId',f->>'kickoff',CASE WHEN (f->>'dateOnly')::boolean THEN 1 ELSE 0 END,f->>'provider',revision)
      ON CONFLICT(id) DO UPDATE SET season_id=excluded.season_id,home_team_id=excluded.home_team_id,away_team_id=excluded.away_team_id,
        kickoff=excluded.kickoff,date_only=excluded.date_only,provider=excluded.provider,current_revision_id=excluded.current_revision_id
      WHERE (SELECT observed_at FROM fixture_revisions WHERE revision_id=excluded.current_revision_id)>=
        (SELECT observed_at FROM fixture_revisions WHERE revision_id=fixture_catalog.current_revision_id);
    INSERT INTO match_results(revision_id,fixture_id,status,home_goals,away_goals,observed_at,provider,source_id)
      VALUES(revision,f->>'id',f->>'status',(f->'score'->>0)::bigint,(f->'score'->>1)::bigint,f->>'observedAt',f->>'provider',f->>'sourceId') ON CONFLICT DO NOTHING;
    IF f->>'status'='finished' AND jsonb_typeof(f->'score')='array' THEN
      FOR side_index IN 0..1 LOOP
        team_id := CASE WHEN side_index=0 THEN item->>'homeId' ELSE item->>'awayId' END;
        stat_id := encode(sha256(convert_to('['||revision||',"'||CASE WHEN side_index=0 THEN 'home' ELSE 'away' END||'","goals"]','UTF8')),'hex');
        INSERT INTO football_statistics(id,fixture_id,team_id,result_revision_id,metric,period,value,observed_at,provider,source_ref)
          VALUES(stat_id,f->>'id',team_id,revision,'goals','regulation',(f->'score'->>side_index)::double precision,f->>'observedAt',f->>'provider',f->>'sourceId') ON CONFLICT DO NOTHING;
      END LOOP;
    END IF;
    INSERT INTO fixture_provenance(fixture_revision_id,raw_observation_id) VALUES(revision,p_raw_id) ON CONFLICT DO NOTHING;
  END LOOP;
END;
$ingest$;
`;
