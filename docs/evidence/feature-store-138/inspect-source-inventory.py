"""Read-only step-1 inspection. Raw download bytes stay in memory, not on disk."""
import concurrent.futures
import csv
import datetime
import gzip
import hashlib
import io
import json
import re
import subprocess
from pathlib import Path

YEARS = tuple(range(2021, 2026))
GSIS = re.compile(r"00-\d{7}")

def api(path):
    return json.loads(subprocess.check_output(['gh', 'api', path], text=True))

def download(url):
    return subprocess.check_output(['curl', '--fail', '--location', '--silent', '--show-error',
                                    '--retry', '2', '--max-time', '180', url])

tags = ['stats_player', 'weekly_rosters', 'pbp_participation', 'schedules']
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    releases = dict(zip(tags, pool.map(lambda tag: api('repos/nflverse/nflverse-data/releases/tags/' + tag), tags)))

tasks = []
for tag in tags:
    names = {asset['name']: asset for asset in releases[tag]['assets']}
    for year in ((None,) if tag == 'schedules' else YEARS):
        base = {'stats_player': f'stats_player_week_{year}',
                'weekly_rosters': f'roster_weekly_{year}',
                'pbp_participation': f'pbp_participation_{year}',
                'schedules': 'games'}[tag]
        chosen = names.get(base + '.csv.gz') or names.get(base + '.csv')
        if chosen is None:
            tasks.append((tag, year, None))
        else:
            tasks.append((tag, year, chosen))

def inspect(task):
    tag, year, asset = task
    if asset is None:
        return {'feed': tag, 'season': year, 'status': 'missing'}, None
    wire = download(asset['browser_download_url'])
    wire_hash = hashlib.sha256(wire).hexdigest()
    if len(wire) != asset['size']:
        raise ValueError('asset-size-changed: ' + asset['name'])
    declared = asset.get('digest')
    if declared and declared != 'sha256:' + wire_hash:
        raise ValueError('asset-digest-changed: ' + asset['name'])
    decoded = gzip.decompress(wire) if asset['name'].endswith('.gz') else wire
    reader = csv.DictReader(io.StringIO(decoded.decode('utf-8-sig'), newline=''))
    header = reader.fieldnames
    if not header or len(header) != len(set(header)):
        raise ValueError('missing-or-duplicate-header: ' + asset['name'])
    record = {
        'feed': tag, 'season': year, 'status': 'inspected',
        'release_id': releases[tag]['id'], 'asset_id': asset['id'],
        'name': asset['name'], 'url': asset['browser_download_url'],
        'metadata_url': f"https://api.github.com/repos/nflverse/nflverse-data/releases/assets/{asset['id']}",
        'release_created_at': releases[tag]['created_at'],
        'asset_created_at': asset['created_at'], 'asset_updated_at': asset['updated_at'],
        'provider_digest': declared, 'sha256': wire_hash,
        'provider_digest_matches': declared == 'sha256:' + wire_hash if declared else None,
        'wire_bytes': len(wire), 'decoded_bytes': len(decoded),
        'decoded_sha256': hashlib.sha256(decoded).hexdigest(),
        'header_sha256_json': hashlib.sha256(json.dumps(header, separators=(',', ':')).encode()).hexdigest(),
        'columns': header, 'row_count': 0,
        'license_id': 'CC-BY-SA-4.0' if tag == 'pbp_participation' else 'CC-BY-4.0',
        'license_basis': 'feed-specific nflreadr load_participation.R' if tag == 'pbp_participation' else 'nflverse-data LICENSE.md',
        'attribution': ('NFL NextGenStats via nflverse' if year and year <= 2022 else 'FTN Data via nflverse')
                       if tag == 'pbp_participation' else ('Lee Sharpe / nflverse' if tag == 'schedules' else 'nflverse contributors'),
        'evidence_basis': 'retrospective', 'historical_availability': 'unverified',
    }
    internal = {'qb': [], 'roster': [], 'participation': {}, 'schedule': [], 'invalid_player_tokens': set()}
    reg_count = missing_ids = malformed = 0
    game_ids = set()
    missing_offense = invalid_gsis = missing_values = zero_attempts = 0
    for row in reader:
        record['row_count'] += 1
        if None in row or any(value is None for value in row.values()):
            malformed += 1
        if tag == 'stats_player':
            if row.get('season_type') == 'REG':
                reg_count += 1
                if row.get('position') == 'QB':
                    player = row.get('player_id', '')
                    if not GSIS.fullmatch(player):
                        invalid_gsis += 1
                    if not row.get('passing_yards') or not row.get('attempts'):
                        missing_values += 1
                    if row.get('attempts') == '0':
                        zero_attempts += 1
                    internal['qb'].append({k: row.get(k) for k in ['player_id', 'game_id', 'week', 'team', 'opponent_team']})
        elif tag == 'weekly_rosters':
            if row.get('game_type') == 'REG':
                reg_count += 1
                if row.get('position') == 'QB':
                    player = row.get('gsis_id', '')
                    if not GSIS.fullmatch(player):
                        invalid_gsis += 1
                    internal['roster'].append({k: row.get(k) for k in ['gsis_id', 'week', 'team']})
        elif tag == 'pbp_participation':
            game = row.get('nflverse_game_id') or row.get('game_id') or ''
            game_ids.add(game)
            if not game:
                missing_ids += 1
            offense = row.get('offense_players', '')
            if not offense or offense == 'NA':
                missing_offense += 1
            internal['participation'].setdefault(game, set()).update(GSIS.findall(offense))
        else:
            if row.get('season') in {str(y) for y in YEARS} and row.get('game_type') == 'REG':
                internal['schedule'].append({k: row.get(k) for k in ['game_id', 'season', 'week', 'home_team', 'away_team', 'gameday', 'gametime', 'home_score', 'away_score']})
    record['malformed_rows'] = malformed
    if tag in ['stats_player', 'weekly_rosters']:
        record['regular_season_rows'] = reg_count
        qb = internal['qb'] if tag == 'stats_player' else internal['roster']
        record['regular_season_qb_rows'] = len(qb)
        record['qb_invalid_or_missing_gsis_rows'] = invalid_gsis
        if tag == 'stats_player':
            record['qb_missing_attempts_or_yards_rows'] = missing_values
            record['qb_zero_attempts_rows'] = zero_attempts
            record['qb_duplicate_player_game_rows'] = len(qb) - len({(r['player_id'], r['game_id']) for r in qb})
    if tag == 'pbp_participation':
        record['games_including_postseason'] = len(game_ids)
        record['missing_game_id_rows'] = missing_ids
        record['missing_offense_player_list_rows'] = missing_offense
        record['offense_player_column_present'] = 'offense_players' in header
    print(json.dumps({'file': record['name'], 'rows': record['row_count'], 'sha256': wire_hash}), flush=True)
    return record, internal

with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    results = list(pool.map(inspect, tasks))

records = [record for record, _ in results]
internal = {(record['feed'], record['season']): data for record, data in results}
schedule = internal[('schedules', None)]['schedule']
coverage = []
for year in YEARS:
    games = [row for row in schedule if row['season'] == str(year)]
    game_set = {row['game_id'] for row in games}
    stats = internal[('stats_player', year)]['qb']
    roster = internal[('weekly_rosters', year)]['roster']
    participation = internal[('pbp_participation', year)]['participation']
    roster_keys = {(r['gsis_id'], r['week']) for r in roster}
    roster_team_keys = {(r['gsis_id'], r['week'], r['team']) for r in roster}
    season = {
        'season': year, 'schedule_regular_games': len(games),
        'schedule_missing_score_games': [r['game_id'] for r in games if not r['home_score'] or not r['away_score'] or r['home_score'] == 'NA' or r['away_score'] == 'NA'],
        'schedule_missing_kickoff_fields_games': [r['game_id'] for r in games if not r['gameday'] or not r['gametime']],
        'stats_qb_rows': len(stats), 'stats_distinct_qbs': len({r['player_id'] for r in stats}),
        'stats_games': len({r['game_id'] for r in stats}),
        'stats_game_ids_not_in_schedule': sorted({r['game_id'] for r in stats} - game_set),
        'stats_qb_rows_missing_weekly_qb_identity': sum((r['player_id'], r['week']) not in roster_keys for r in stats),
        'stats_qb_rows_missing_exact_weekly_qb_team': sum((r['player_id'], r['week'], r['team']) not in roster_team_keys for r in stats),
        'weekly_roster_qb_rows': len(roster),
        'participation_regular_games_present': len(game_set & set(participation)),
        'participation_regular_games_missing': sorted(game_set - set(participation)),
        'stats_qb_rows_with_offense_gsis_match': sum(r['player_id'] in participation.get(r['game_id'], set()) for r in stats),
        'stats_qb_rows_without_offense_gsis_match': sum(r['player_id'] not in participation.get(r['game_id'], set()) for r in stats),
        'qualification': 'inventory-only; participation and identity gaps are reported, not a population-completeness claim',
    }
    coverage.append(season)

output = {
    'schema_version': 'feature-store-source-inventory-v1',
    'inspected_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'inspection_code_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'scope': {'market': 'player_pass_yds', 'seasons': list(YEARS), 'season_type': 'REG'},
    'inspection_only': True, 'evaluation_run': False, 'performance_benchmark': False,
    'raw_bytes_persisted': False,
    'assets': records, 'coverage_by_season': coverage,
}
out = Path('/private/tmp/dfs138-source-inventory.json')
out.write_text(json.dumps(output, indent=2) + '\n')
print(json.dumps({'report': str(out), 'assets': len(records), 'coverage_by_season': coverage}), flush=True)
