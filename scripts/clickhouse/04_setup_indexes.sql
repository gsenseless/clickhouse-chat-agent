-- Add a text index on the market question (tokenize on non-alphanumeric boundaries,
-- lower-case via preprocessor so search is case-insensitive by default)
ALTER TABLE polymarket.markets
    ADD INDEX idx_question_text lower(question) TYPE text(tokenizer = splitByNonAlpha);

-- Build it for the ~1M existing rows (cheap — this table is small)
ALTER TABLE polymarket.markets MATERIALIZE INDEX idx_question_text SETTINGS mutations_sync = 2;

-- Optional: same treatment for event_title if you search on the parent event grouping
ALTER TABLE polymarket.markets
    ADD INDEX idx_event_title_text lower(event_title) TYPE text(tokenizer = splitByNonAlpha);
ALTER TABLE polymarket.markets MATERIALIZE INDEX idx_event_title_text SETTINGS mutations_sync = 2;