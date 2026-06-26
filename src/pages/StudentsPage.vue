<template>
  <q-page padding>
    <q-card flat bordered>
      <q-card-section class="row items-center q-gutter-md">
        <div class="text-h6">学生信息管理</div>
        <q-space />
        <q-input
          v-model="keyword"
          dense
          outlined
          clearable
          placeholder="搜索学号 / 姓名"
          style="min-width: 220px"
          @update:model-value="onSearch"
          @clear="onSearch"
        >
          <template #prepend>
            <q-icon name="search" />
          </template>
        </q-input>
        <q-btn
          color="primary"
          icon="add"
          label="新增"
          no-caps
          unelevated
          @click="openCreate"
        />
      </q-card-section>

      <q-separator />

      <q-table
        :rows="rows"
        :columns="columns"
        row-key="id"
        :loading="loading"
        :pagination="{ rowsPerPage: 10, sortBy: 'createdAt', descending: true }"
        flat
      >
        <template #body-cell-gender="props">
          <q-td :props="props">
            <q-badge
              :color="props.row.gender === '男' ? 'blue' : 'pink'"
              :label="props.row.gender"
            />
          </q-td>
        </template>

        <template #body-cell-actions="props">
          <q-td :props="props" class="q-gutter-xs">
            <q-btn
              flat
              round
              dense
              color="primary"
              icon="edit"
              @click="openEdit(props.row)"
            >
              <q-tooltip>编辑</q-tooltip>
            </q-btn>
            <q-btn
              flat
              round
              dense
              color="negative"
              icon="delete"
              @click="confirmDelete(props.row)"
            >
              <q-tooltip>删除</q-tooltip>
            </q-btn>
          </q-td>
        </template>

        <template #no-data>
          <div class="full-width row flex-center q-pa-md text-grey">
            暂无学生数据
          </div>
        </template>
      </q-table>
    </q-card>

    <!-- 新增/编辑弹窗 -->
    <q-dialog v-model="formDialog" persistent>
      <q-card style="min-width: 420px">
        <q-card-section class="row items-center">
          <div class="text-h6">
            {{ editingId ? "编辑学生" : "新增学生" }}
          </div>
          <q-space />
          <q-btn flat round dense icon="close" v-close-popup />
        </q-card-section>

        <q-form @submit.prevent="submitForm">
          <q-card-section class="q-gutter-md">
            <q-input
              v-model="form.studentNo"
              outlined
              dense
              label="学号 *"
              :rules="[v => !!v || '请输入学号']"
            />
            <q-input
              v-model="form.name"
              outlined
              dense
              label="姓名 *"
              :rules="[v => !!v || '请输入姓名']"
            />
            <q-select
              v-model="form.gender"
              outlined
              dense
              emit-value
              map-options
              label="性别 *"
              :options="[
                { label: '男', value: '男' },
                { label: '女', value: '女' }
              ]"
              :rules="[v => !!v || '请选择性别']"
            />
            <q-input
              v-model.number="form.age"
              outlined
              dense
              type="number"
              label="年龄"
              :rules="[
                v =>
                  v === null ||
                  v === undefined ||
                  (v >= 0 && v <= 150) ||
                  '请输入合法年龄'
              ]"
            />
            <q-input
              v-model="form.major"
              outlined
              dense
              label="专业"
            />
          </q-card-section>

          <q-card-actions align="right" class="q-pb-md q-pr-md">
            <q-btn flat label="取消" color="grey" v-close-popup />
            <q-btn
              unelevated
              label="保存"
              color="primary"
              type="submit"
              :loading="submitting"
            />
          </q-card-actions>
        </q-form>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useQuasar } from "quasar";

const $q = useQuasar();

const columns = [
  {
    name: "studentNo",
    label: "学号",
    field: "studentNo",
    align: "left" as const,
    sortable: true
  },
  {
    name: "name",
    label: "姓名",
    field: "name",
    align: "left" as const,
    sortable: true
  },
  {
    name: "gender",
    label: "性别",
    field: "gender",
    align: "center" as const
  },
  {
    name: "age",
    label: "年龄",
    field: "age",
    align: "center" as const,
    sortable: true
  },
  {
    name: "major",
    label: "专业",
    field: "major",
    align: "left" as const
  },
  {
    name: "createdAt",
    label: "创建时间",
    field: "createdAt",
    align: "left" as const,
    format: (val: number) => new Date(val * 1000).toLocaleString(),
    sortable: true
  },
  {
    name: "actions",
    label: "操作",
    field: "actions",
    align: "center" as const
  }
];

const rows = ref<Student[]>([]);
const loading = ref(false);
const keyword = ref("");

const formDialog = ref(false);
const submitting = ref(false);
const editingId = ref<number | null>(null);

const defaultForm = (): StudentInput => ({
  studentNo: "",
  name: "",
  gender: "男",
  age: null,
  major: ""
});
const form = ref<StudentInput>(defaultForm());

let searchTimer: ReturnType<typeof setTimeout> | null = null;

async function loadList() {
  loading.value = true;
  try {
    rows.value = await window.studentApi.list(keyword.value || undefined);
  } catch (err) {
    console.error(err);
    $q.notify({ type: "negative", message: "加载列表失败" });
  } finally {
    loading.value = false;
  }
}

function onSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadList(), 300);
}

function openCreate() {
  editingId.value = null;
  form.value = defaultForm();
  formDialog.value = true;
}

function openEdit(row: Student) {
  editingId.value = row.id;
  form.value = {
    studentNo: row.studentNo,
    name: row.name,
    gender: row.gender,
    age: row.age,
    major: row.major ?? ""
  };
  formDialog.value = true;
}

async function submitForm() {
  submitting.value = true;
  try {
    const data: StudentInput = {
      ...form.value,
      age:
        form.value.age === null ||
        form.value.age === undefined ||
        Number.isNaN(form.value.age)
          ? null
          : Number(form.value.age),
      major: form.value.major?.trim() || null
    };
    if (editingId.value) {
      await window.studentApi.update(editingId.value, data);
      $q.notify({ type: "positive", message: "更新成功" });
    } else {
      await window.studentApi.create(data);
      $q.notify({ type: "positive", message: "新增成功" });
    }
    formDialog.value = false;
    await loadList();
  } catch (err) {
    console.error(err);
    const message =
      err instanceof Error ? err.message : "保存失败（学号可能重复）";
    $q.notify({ type: "negative", message });
  } finally {
    submitting.value = false;
  }
}

function confirmDelete(row: Student) {
  $q
    .dialog({
      title: "确认删除",
      message: `确定要删除学生「${row.name}（${row.studentNo}」吗？`,
      ok: { label: "删除", color: "negative", unelevated: true },
      cancel: { label: "取消", flat: true },
      persistent: true
    })
    .onOk(async () => {
      try {
        await window.studentApi.remove(row.id);
        $q.notify({ type: "positive", message: "删除成功" });
        await loadList();
      } catch (err) {
        console.error(err);
        $q.notify({ type: "negative", message: "删除失败" });
      }
    });
}

onMounted(() => loadList());
</script>
