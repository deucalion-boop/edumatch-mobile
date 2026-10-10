import assert from 'node:assert/strict';
import test from 'node:test';
import { getLearningPage } from '../src/screens/learningPagination';

test('eleven learning records occupy pages of five, five, and one without omissions or overlap', () => {
  const records = Array.from({ length: 11 }, (_, index) => ({ id: `lesson-${index + 1}` }));
  const pages = [1, 2, 3].map(page => getLearningPage(records, page));

  assert.deepEqual(pages.map(({ records, page, totalPages, totalRecords, start, end }) => ({
    count: records.length, page, totalPages, totalRecords, start, end,
  })), [
    { count: 5, page: 1, totalPages: 3, totalRecords: 11, start: 1, end: 5 },
    { count: 5, page: 2, totalPages: 3, totalRecords: 11, start: 6, end: 10 },
    { count: 1, page: 3, totalPages: 3, totalRecords: 11, start: 11, end: 11 },
  ]);
  const displayed = pages.flatMap(page => page.records);
  assert.deepEqual(displayed, records);
  assert.equal(new Set(displayed.map(record => record.id)).size, records.length);
});

test('exact five-record boundaries have no extra empty page', () => {
  const records = Array.from({ length: 10 }, (_, index) => index + 1);
  const five = getLearningPage(records.slice(0, 5), 2);
  assert.equal(five.page, 1);
  assert.equal(five.totalPages, 1);
  assert.deepEqual(five.records, [1, 2, 3, 4, 5]);
  const six = getLearningPage(records.slice(0, 6), 2);
  assert.equal(six.totalPages, 2);
  assert.deepEqual(six.records, [6]);
  const ten = getLearningPage(records, 2);
  assert.equal(ten.totalPages, 2);
  assert.deepEqual(ten.records, [6, 7, 8, 9, 10]);
  assert.equal(ten.end, 10);
});

test('refreshing a smaller list clamps the selected page to remaining records', () => {
  const records = Array.from({ length: 11 }, (_, index) => index + 1);
  assert.equal(getLearningPage(records, 3).page, 3);
  const reduced = getLearningPage(records.slice(0, 6), 3);
  assert.deepEqual(reduced, {
    records: [6], page: 2, totalPages: 2, totalRecords: 6, start: 6, end: 6,
  });
  assert.equal(getLearningPage(records.slice(0, 5), 3).page, 1);
  assert.equal(getLearningPage(records, 99).page, 3);
  for (const requestedPage of [0, -1, -99]) {
    assert.equal(getLearningPage(records, requestedPage).page, 1);
  }
});

test('an empty list always has a valid first page and an empty displayed range', () => {
  for (const requestedPage of [1, 3, 99, 0, -1, NaN]) {
    assert.deepEqual(getLearningPage([], requestedPage), {
      records: [], page: 1, totalPages: 1, totalRecords: 0, start: 0, end: 0,
    });
  }
});

test('page normalization and slicing leave the source list unchanged', () => {
  const records = Object.freeze(Array.from({ length: 11 }, (_, index) => index + 1));
  assert.equal(getLearningPage(records, 2.8).page, 2);
  assert.equal(getLearningPage(records, NaN).page, 1);
  assert.equal(getLearningPage(records, Infinity).page, 3);
  assert.equal(getLearningPage(records, -Infinity).page, 1);
  const page = getLearningPage(records, 1);
  page.records.pop();
  assert.equal(records.length, 11);
  assert.deepEqual(records, Array.from({ length: 11 }, (_, index) => index + 1));
});
