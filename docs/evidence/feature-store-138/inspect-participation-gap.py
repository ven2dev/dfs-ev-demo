import csv
import hashlib
import io
import json
import subprocess
import gzip
import re
from pathlib import Path

path = Path('/private/tmp/dfs138-source-inventory.json')
report = json.loads(path.read_text())
def rows(feed):
    asset = next(a for a in report['assets'] if a['feed'] == feed and a['season'] == 2025)
    wire = subprocess.check_output(['curl', '--fail', '--location', '--silent', '--show-error',
                                    '--max-time', '180', asset['url']])
    assert hashlib.sha256(wire).hexdigest() == asset['sha256']
    data = gzip.decompress(wire) if asset['name'].endswith('.gz') else wire
    return list(csv.DictReader(io.StringIO(data.decode('utf-8-sig'), newline='')))

stats = rows('stats_player')
offense = {}
for row in rows('pbp_participation'):
    offense.setdefault(row['nflverse_game_id'], set()).update(re.findall(r'00-\d{7}', row.get('offense_players', '')))
missing = [{key: row.get(key) for key in ['player_id', 'player_display_name', 'game_id', 'season',
           'week', 'team', 'attempts', 'passing_yards']} for row in stats
           if row['season_type'] == 'REG' and row['position'] == 'QB'
           and row['player_id'] not in offense.get(row['game_id'], set())]
report['participation_gaps'] = missing
path.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(missing, indent=2))
