'use strict';

const { defineModel, field } = require('../_shared/liteorm');
const { openExampleDb, printSummary } = require('../_shared/db');

const db = openExampleDb('todo');
for (const table of ['tasks', 'projects']) db.schema.dropTable(table);

db.schema.createTable('projects', t => {
  t.increments('id');
  t.text('name').notNull();
  t.timestamps();
});

db.schema.createTable('tasks', t => {
  t.increments('id');
  t.integer('project_id').notNull().references('projects', 'id');
  t.text('title').notNull();
  t.text('status').default('open');
  t.integer('priority').default(1);
  t.json('labels');
  t.text('due_at').nullable();
  t.timestamps();
  t.softDeletes();
});

const Project = defineModel(db, 'projects', {
  timestamps: true,
  relations: { tasks: { type: 'hasMany', model: 'tasks', foreignKey: 'project_id' } }
});

const Task = defineModel(db, 'tasks', {
  timestamps: true,
  softDelete: true,
  json: ['labels'],
  fields: {
    title: field.text().required().min(3),
    status: field.text().enum(['open', 'done']).default('open'),
    priority: field.integer().default(1),
    labels: field.json().default([])
  },
  scopes: {
    open: q => q.where('status', '=', 'open'),
    done: q => q.where('status', '=', 'done')
  },
  relations: { project: { type: 'belongsTo', model: 'projects', foreignKey: 'project_id' } }
});

const project = Project.create({ name: 'Launch v1.1' });

Task.insertMany([
  { project_id: project.id, title: 'Write package readiness docs', status: 'open', priority: 10, labels: ['docs', 'release'] },
  { project_id: project.id, title: 'Run smoke install test', status: 'open', priority: 9, labels: ['ci'] },
  { project_id: project.id, title: 'Publish npm package', status: 'done', priority: 5, labels: ['npm'] }
]);

const doomed = Task.create({ project_id: project.id, title: 'Temporary deleted task', status: 'open', priority: 1, labels: [] });
Task.delete(doomed.id);

const loaded = Project.query().with('tasks').where('id', '=', project.id).first();
const highPriority = Task.query().scope('open').where('priority', '>=', 10).orderBy('priority', 'desc').get().map(t => t.title);

printSummary({
  project: loaded.name,
  openTasks: Task.query().scope('open').count(),
  doneTasks: Task.query().scope('done').count(),
  highPriority,
  softDeletedHidden: Task.find(doomed.id) === null
});

db.close();
