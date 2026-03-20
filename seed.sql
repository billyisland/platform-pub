-- 1. Create 5 Test Writers
INSERT INTO accounts (username, display_name, bio, nostr_pubkey, is_writer, status, created_at)
VALUES 
('satoshi', 'Satoshi Nakamoto', 'The ghost in the machine.', 'npub1satoshi0000000000000000000000000000000000000000000000001', TRUE, 'active', now()),
('alice', 'Alice Wonder', 'Exploring the rabbit hole of Web3.', 'npub1alice000000000000000000000000000000000000000000000000002', TRUE, 'active', now()),
('bob', 'Builder Bob', 'I build things on Nostr.', 'npub1bob00000000000000000000000000000000000000000000000000003', TRUE, 'active', now()),
('charlie', 'Charlie Checkers', 'Strategic thoughts on the creator economy.', 'npub1charlie000000000000000000000000000000000000000000000004', TRUE, 'active', now()),
('dana', 'Dana Data', 'Visualizing the decentralized web.', 'npub1dana000000000000000000000000000000000000000000000000005', TRUE, 'active', now())
ON CONFLICT (username) DO NOTHING;

-- 2. Create 5 Paywalled Articles
-- Note: We map them to the writers we just created
INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug, content_free, word_count, is_paywalled, price_pence, gate_position_pct, published_at)
SELECT id, 'event_id_1', 'd_tag_1', 'The Future of Money', 'future-of-money', 'This is the free intro about Bitcoin...', 500, TRUE, 50, 30, now() FROM accounts WHERE username = 'satoshi';

INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug, content_free, word_count, is_paywalled, price_pence, gate_position_pct, published_at)
SELECT id, 'event_id_2', 'd_tag_2', 'Down the Rabbit Hole', 'rabbit-hole', 'Curiosity leads to strange places...', 800, TRUE, 25, 20, now() FROM accounts WHERE username = 'alice';

INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug, content_free, word_count, is_paywalled, price_pence, gate_position_pct, published_at)
SELECT id, 'event_id_3', 'd_tag_3', 'Building on Nostr', 'building-nostr', 'Why NIPs matter for the future of social...', 1200, TRUE, 100, 15, now() FROM accounts WHERE username = 'bob';

INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug, content_free, word_count, is_paywalled, price_pence, gate_position_pct, published_at)
SELECT id, 'event_id_4', 'd_tag_4', 'Creator Economy 2.0', 'creator-economy', 'Moving away from the ad-model...', 650, FALSE, 0, 100, now() FROM accounts WHERE username = 'charlie';

INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug, content_free, word_count, is_paywalled, price_pence, gate_position_pct, published_at)
SELECT id, 'event_id_5', 'd_tag_5', 'Data Sovereignty', 'data-sovereignty', 'Who owns your digital footprint?', 950, TRUE, 75, 40, now() FROM accounts WHERE username = 'dana';
