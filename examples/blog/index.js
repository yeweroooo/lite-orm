'use strict';

const { defineModel, field } = require('../_shared/liteorm');
const { openExampleDb, printSummary } = require('../_shared/db');

const db = openExampleDb('blog');
for (const table of ['posts_search', 'post_tags', 'comments', 'posts', 'tags', 'users']) {
  try { db.schema.dropTable(table); } catch (_) {}
}

db.schema.createTable('users', t => {
  t.increments('id');
  t.text('name').notNull();
  t.text('email').notNull().unique();
  t.text('password').notNull();
  t.timestamps();
});

db.schema.createTable('posts', t => {
  t.increments('id');
  t.integer('user_id').notNull().references('users', 'id');
  t.text('title').notNull();
  t.text('body');
  t.text('status').default('draft');
  t.json('meta');
  t.timestamps();
});

db.schema.createTable('comments', t => {
  t.increments('id');
  t.integer('post_id').notNull().references('posts', 'id');
  t.text('body').notNull();
});

db.schema.createTable('tags', t => {
  t.increments('id');
  t.text('name').notNull().unique();
});

db.schema.createTable('post_tags', t => {
  t.integer('post_id').notNull().references('posts', 'id');
  t.integer('tag_id').notNull().references('tags', 'id');
  t.unique(['post_id', 'tag_id']);
});

const User = defineModel(db, 'users', {
  timestamps: true,
  hidden: ['password'],
  fields: { email: field.text().email().required(), password: field.text().hidden() },
  computed: { label: u => `${u.name}<${u.email}>` },
  relations: { posts: { type: 'hasMany', model: 'posts', foreignKey: 'user_id' } }
});
const Post = defineModel(db, 'posts', {
  timestamps: true,
  json: ['meta'],
  fields: { meta: field.json().default({}), status: field.text().default('draft') },
  relations: {
    user: { type: 'belongsTo', model: 'users', foreignKey: 'user_id' },
    comments: { type: 'hasMany', model: 'comments', foreignKey: 'post_id' },
    tags: { type: 'belongsToMany', model: 'tags', pivot: 'post_tags', foreignPivotKey: 'post_id', relatedPivotKey: 'tag_id' }
  }
});
defineModel(db, 'comments', { relations: { post: { type: 'belongsTo', model: 'posts', foreignKey: 'post_id' } } });
defineModel(db, 'tags', { relations: { posts: { type: 'belongsToMany', model: 'posts', pivot: 'post_tags', foreignPivotKey: 'tag_id', relatedPivotKey: 'post_id' } } });

const author = User.create({ name: 'Adit', email: 'adit@test.local', password: 'secret' });
const first = Post.create({ user_id: author.id, title: 'Hello SQLite', body: 'Native ORM with FTS5', status: 'published', meta: { topic: 'sqlite' } });
Post.create({ user_id: author.id, title: 'Lite ORM Release', body: 'Zero dependency package', status: 'published', meta: { topic: 'release' } });
const sqlite = db.query('INSERT INTO tags(name) VALUES(?), (?) RETURNING id, name', ['sqlite', 'orm']);
db.exec('INSERT INTO post_tags(post_id, tag_id) VALUES(?, ?), (?, ?)', [first.id, sqlite[0].id, first.id, sqlite[1].id]);
db.exec('INSERT INTO comments(post_id, body) VALUES(?, ?), (?, ?)', [first.id, 'Great', first.id, 'Ship it']);

db.fts.create('posts_search', { columns: ['title', 'body'] });
db.fts.insert('posts_search', { title: first.title, body: first.body });

const loaded = Post.query().with('tags').withCount('comments').where('id', '=', first.id).first();

printSummary({
  author: User.find(author.id).toJSON().label,
  publishedPosts: Post.query().where('status', '=', 'published').count(),
  firstPostTags: loaded.tags.map(t => t.name).sort(),
  searchResults: db.fts.search('posts_search', 'sqlite').map(r => r.title),
  commentsCount: loaded.comments_count
});

db.close();
